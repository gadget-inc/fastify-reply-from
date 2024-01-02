'use strict'

const fp = require('fastify-plugin')
const { lru } = require('tiny-lru')
const querystring = require('fast-querystring')
const Stream = require('node:stream')
const buildRequest = require('./lib/request')
const {
  filterPseudoHeaders,
  copyHeaders,
  stripHttp1ConnectionHeaders,
  buildURL
} = require('./lib/utils')

const {
  TimeoutError,
  ServiceUnavailableError,
  GatewayTimeoutError,
  ConnectionResetError,
  ConnectTimeoutError,
  UndiciSocketError,
  InternalServerError
} = require('./lib/errors')

const fastifyReplyFrom = fp(function from (fastify, opts, next) {
  const retryMethods = new Set(opts.retryMethods || [
    'GET', 'HEAD', 'OPTIONS', 'TRACE'])

  const cache = opts.disableCache ? undefined : lru(opts.cacheURLs || 100)
  const base = opts.base
  const requestBuilt = buildRequest({
    http: opts.http,
    http2: opts.http2,
    base,
    undici: opts.undici,
    globalAgent: opts.globalAgent,
    destroyAgent: opts.destroyAgent
  })
  if (requestBuilt instanceof Error) {
    next(requestBuilt)
    return
  }
  const { request, close, retryOnError } = requestBuilt
  const disableRequestLogging = opts.disableRequestLogging || false

  fastify.decorateReply('from', function (source, opts) {
    opts = opts || {}
    const req = this.request.raw
    const method = opts.method || req.method
    const onResponse = opts.onResponse
    const rewriteHeaders = opts.rewriteHeaders || headersNoOp
    const rewriteRequestHeaders = opts.rewriteRequestHeaders || requestHeadersNoOp
    const getUpstream = opts.getUpstream || upstreamNoOp
    const onError = opts.onError || onErrorDefault
    const retriesCount = opts.retriesCount || 0
    const maxRetriesOn503 = opts.maxRetriesOn503 || 10
    const customRetry = opts.customRetry || undefined

    if (!source) {
      source = req.url
    }

    // we leverage caching to avoid parsing the destination URL
    const dest = getUpstream(this.request, base)
    let url
    if (cache) {
      const cacheKey = dest + source
      url = cache.get(cacheKey) || buildURL(source, dest)
      cache.set(cacheKey, url)
    } else {
      url = buildURL(source, dest)
    }

    const sourceHttp2 = req.httpVersionMajor === 2
    const headers = sourceHttp2 ? filterPseudoHeaders(req.headers) : { ...req.headers }
    headers.host = url.host
    const qs = getQueryString(url.search, req.url, opts)
    let body = undefined

    if (opts.body !== undefined) {
      if (opts.body !== null) {
        if (typeof opts.body.pipe === 'function') {
          throw new Error('sending a new body as a stream is not supported yet')
        }

        body = opts.body
        headers['content-length'] = Buffer.byteLength(body)
        headers['content-type'] = opts.contentType
      } else {
        delete headers['content-length']
        delete headers['content-type']
      }
    }

    // according to https://tools.ietf.org/html/rfc2616#section-4.3
    // fastify ignore message body when it's a GET or HEAD request
    // when proxy this request, we should reset the content-length to make it a valid http request
    // discussion: https://github.com/fastify/fastify/issues/953
    if (method === 'GET' || method === 'HEAD') {
      // body will be populated here only if opts.body is passed.
      // if we are doing that with a GET or HEAD request is a programmer error
      // and as such we can throw immediately.
      if (body) {
        throw new Error(`Rewriting the body when doing a ${method} is not allowed`)
      }
    }

    const requestHeaders = rewriteRequestHeaders(this.request, headers)
    const contentLength = requestHeaders['content-length']
    let requestImpl
    if (retryMethods.has(method) && !contentLength) {
      const retryHandler = (req, res, err, retries) => {
        const getDefaultDelay = () => {
          // Magic number, so why not 42? We might want to make this configurable.
          let retryAfter = 42 * Math.random() * (retries + 1)

          if (res && res.headers['retry-after']) {
            retryAfter = res.headers['retry-after']
          }
          if (res && res.statusCode === 503 && req.method === 'GET') {
            if (retriesCount === 0 && retries < maxRetriesOn503) {
              // we should stop at some point
              return retryAfter
            }
          } else if (retriesCount > retries && err && err.code === retryOnError) {
            return retryAfter
          }
          return null
        }

        if (customRetry && customRetry.handler) {
          const customRetries = customRetry.retries || 1
          if (++retries < customRetries) {
            return customRetry.handler({ err, req, res, getDefaultDelay })
          }
        }
        return getDefaultDelay()
      }

      this.request.log.info({ method: req.method, source, hasBody: body?.length >= 0, contentLength }, 'fetching from remote server')

      requestImpl = createRequestRetry(request, this, retryHandler)
    } else {
      requestImpl = request
    }

    requestImpl({ method, url, qs, headers: requestHeaders, body }, (err, res) => {
      if (err) {
        this.request.log.warn(err, 'response errored')
        if (!this.sent) {
          if (err.code === 'ERR_HTTP2_STREAM_CANCEL' || err.code === 'ENOTFOUND') {
            onError(this, { error: ServiceUnavailableError() })
          } else if (err instanceof TimeoutError || err.code === 'UND_ERR_HEADERS_TIMEOUT') {
            onError(this, { error: new GatewayTimeoutError() })
          } else if (err.code === 'ECONNRESET') {
            onError(this, { error: new ConnectionResetError() })
          } else if (err.code === 'UND_ERR_SOCKET') {
            onError(this, { error: new UndiciSocketError() })
          } else if (err.code === 'UND_ERR_CONNECT_TIMEOUT') {
            onError(this, { error: new ConnectTimeoutError() })
          } else {
            onError(this, { error: new InternalServerError(err.message) })
          }
        }
        return
      }
      !disableRequestLogging && this.request.log.info('response received')
      if (sourceHttp2) {
        copyHeaders(
          rewriteHeaders(stripHttp1ConnectionHeaders(res.headers), this.request),
          this
        )
      } else {
        copyHeaders(rewriteHeaders(res.headers, this.request), this)
      }
      this.code(res.statusCode)
      if (onResponse) {
        onResponse(this.request, this, res)
      } else {
        this.send(res.stream)
      }
    })
    return this
  })

  fastify.addHook('onReady', (done) => {
    if (isFastifyMultipartRegistered(fastify)) {
      fastify.log.warn('@fastify/reply-from might not behave as expected when used with @fastify/multipart')
    }
    done()
  })

  fastify.onClose((fastify, next) => {
    close()
    // let the event loop do a full run so that it can
    // actually destroy those sockets
    setImmediate(next)
  })

  next()
}, {
  fastify: '4.x',
  name: '@fastify/reply-from'
})

function getQueryString (search, reqUrl, opts) {
  if (typeof opts.queryString === 'function') {
    return '?' + opts.queryString(search, reqUrl)
  }

  if (opts.queryString) {
    return '?' + querystring.stringify(opts.queryString)
  }

  if (search.length > 0) {
    return search
  }

  const queryIndex = reqUrl.indexOf('?')

  if (queryIndex > 0) {
    return reqUrl.slice(queryIndex)
  }

  return ''
}

function headersNoOp (headers, originalReq) {
  return headers
}

function requestHeadersNoOp (originalReq, headers) {
  return headers
}

function upstreamNoOp (req, base) {
  return base
}

function onErrorDefault (reply, { error }) {
  reply.send(error)
}

function isFastifyMultipartRegistered (fastify) {
  // TODO: remove fastify.hasContentTypeParser('multipart') in next major
  // It is used to be compatible with @fastify/multipart@<=7.3.0
  return (fastify.hasContentTypeParser('multipart') || fastify.hasContentTypeParser('multipart/form-data')) && fastify.hasRequestDecorator('multipart')
}

function createRequestRetry (requestImpl, reply, retryHandler) {
  function requestRetry (req, cb) {
    let retries = 0

    function run () {
      requestImpl(req, function (err, res) {
        const retryDelay = retryHandler(req, res, err, retries)
        if (!reply.sent && retryDelay) {
          return retry(retryDelay)
        }
        cb(err, res)
      })
    }

    function retry (after) {
      retries += 1
      setTimeout(run, after)
    }

    run()
  }

  return requestRetry
}

module.exports = fastifyReplyFrom
module.exports.default = fastifyReplyFrom
module.exports.fastifyReplyFrom = fastifyReplyFrom
