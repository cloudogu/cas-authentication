var url           = require('url'),
    http          = require('http'),
    https         = require('https'),
    parseXML      = require('xml2js').parseString,
    client        = require('request-promise'),
    xml2json      = require('simple-xml2json'),
    XMLprocessors = require('xml2js/lib/processors')

/**
 * The CAS authentication types.
 * @enum {number}
 */
var AUTH_TYPE = {
    BOUNCE          : 0,
    BOUNCE_REDIRECT : 1,
    BLOCK           : 2
};

var DEFAULT_REDIRECT_PATH = '/';
var proxyTokens ={};
// used for back channel logout; contains: Service Ticket -> SessionID
var sessionMap = new Map();
var proxyCbUrl = '/api/v1/pgtCallback';


/**
 * @typedef {Object} CAS_options
 * @property {string}  cas_url
 * @property {string}  service_url
 * @property {('1.0'|'2.0'|'3.0'|'saml1.1')} [cas_version='3.0']
 * @property {boolean} [renew=false]
 * @property {boolean} [is_dev_mode=false]
 * @property {string}  [dev_mode_user='']
 * @property {Object}  [dev_mode_info={}]
 * @property {string}  [session_name='cas_user']
 * @property {string}  [session_info=false]
 * @property {boolean} [destroy_session=false]
 * @property {string} [proxyCallback_url]
 */

/**
 * @param {CAS_options} options
 * @constructor
 */
function CASAuthentication(options) {

    if (!options || typeof options !== 'object') {
        throw new Error( 'CAS Authentication was not given a valid configuration object.');
    }
    if (options.cas_url === undefined) {
        throw new Error('CAS Authentication requires a cas_url parameter.');
    }
    if (options.service_url === undefined) {
        throw new Error( 'CAS Authentication requires a service_url parameter.');
    }

    this.cas_version = options.cas_version !== undefined ? options.cas_version : '3.0';

    if (this.cas_version === '1.0') {
        this._validateUri = '/validate';
        this._validate = function(body, callback) {
            var lines = body.split('\n');
            if (lines[ 0 ] === 'yes' && lines.length >= 2) {
                return callback(null, lines[ 1 ]);
            }
            else if (lines[ 0 ] === 'no') {
                return callback( new Error('CAS authentication failed.'));
            }
            else {
                return callback( new Error('Response from CAS server was bad.'));
            }
        }
    }
    else if (this.cas_version === '2.0' || this.cas_version === '3.0') {
        this._validateUri = (this.cas_version === '2.0' ? '/serviceValidate' : '/p3/serviceValidate');
        this._validate = function(body, callback) {
            parseXML(body, {
                trim: true,
                normalize: true,
                explicitArray: false,
                tagNameProcessors: [ XMLprocessors.normalize, XMLprocessors.stripPrefix ]
            }, function(err, result) {
                if (err) {
                    return callback(new Error('Response from CAS server was bad.'));
                }
                try {
                    var failure = result.serviceresponse.authenticationfailure;
                    if (failure) {
                        return callback(new Error('CAS authentication failed (' + failure.$.code + ').'));
                    }
                    var success = result.serviceresponse.authenticationsuccess;
                    if (success) {
                        return callback(null, success.user, success.attributes, success.proxygrantingticket);
                    }
                    else {
                        return callback(new Error( 'CAS authentication failed.'));
                    }
                }
                catch (err) {
                    console.log(err);
                    return callback(new Error('CAS authentication failed.'));
                }
            });
        }
    }
    else if(this.cas_version === 'saml1.1') {
        this._validateUri = '/samlValidate';
        this._validate = function(body, callback) {
            parseXML(body, {
                trim: true,
                normalize: true,
                explicitArray: false,
                tagNameProcessors: [ XMLprocessors.normalize, XMLprocessors.stripPrefix ]
            }, function(err, result) {
                if (err) {
                    return callback(new Error('Response from CAS server was bad.'));
                }
                try {
                    var samlResponse = result.envelope.body.response;
                    var success = samlResponse.status.statuscode.$.Value.split(':')[ 1 ];
                    if (success !== 'Success') {
                        return callback(new Error('CAS authentication failed (' + success + ').'));
                    }
                    else {
                        var attributes = {};
                        var attributesArray = samlResponse.assertion.attributestatement.attribute;
                        if (!(attributesArray instanceof Array)) {
                            attributesArray = [ attributesArray ];
                        }
                        attributesArray.forEach(function(attr){
                            var thisAttrValue;
                            if (attr.attributevalue instanceof Array){
                                thisAttrValue = [];
                                attr.attributevalue.forEach(function(v) {
                                    thisAttrValue.push(v._);
                                });
                            }
                            else {
                                thisAttrValue = attr.attributevalue._;
                            }
                            attributes[ attr.$.AttributeName ] = thisAttrValue;
                        });
                        return callback(null, samlResponse.assertion.authenticationstatement.subject.nameidentifier, attributes);
                    }
                }
                catch (err) {
                    console.log(err);
                    return callback(new Error('CAS authentication failed.'));
                }
            });
        }
    }
    else {
        throw new Error('The supplied CAS version ("' + this.cas_version + '") is not supported.');
    }

    this.cas_url         = options.cas_url;
    var parsed_cas_url   = url.parse(this.cas_url);
    this.request_client  = parsed_cas_url.protocol === 'http:' ? http : https;
    this.cas_host        = parsed_cas_url.hostname;
    this.cas_port        = parsed_cas_url.protocol === 'http:' ? 80 : 443;
    this.cas_path        = parsed_cas_url.pathname;

    this.service_url     = options.service_url;

    this.proxyCallback_url = options.proxyCallback_url;

    this.renew           = options.renew !== undefined ? !!options.renew : false;

    this.is_dev_mode     = options.is_dev_mode !== undefined ? !!options.is_dev_mode : false;
    this.dev_mode_user   = options.dev_mode_user !== undefined ? options.dev_mode_user : '';
    this.dev_mode_info   = options.dev_mode_info !== undefined ? options.dev_mode_info : {};

    this.session_name    = options.session_name !== undefined ? options.session_name : 'cas_user';
    this.session_info    = [ '2.0', '3.0', 'saml1.1' ].indexOf(this.cas_version) >= 0 && options.session_info !== undefined ? options.session_info : false;
    this.destroy_session = options.destroy_session !== undefined ? !!options.destroy_session : false;

    // Bind the prototype routing methods to this instance of CASAuthentication.
    this.bounce          = this.bounce.bind(this);
    this.bounce_redirect = this.bounce_redirect.bind(this);
    this.block           = this.block.bind(this);
    this.logout          = this.logout.bind(this);
}

/**
 * Bounces a request with CAS authentication. If the user's session is not
 * already validated with CAS, their request will be redirected to the CAS
 * login page.
 */
CASAuthentication.prototype.bounce = function(req, res, next) {

    // Handle the request with the bounce authorization type.
    this._handle(req, res, next, AUTH_TYPE.BOUNCE);
};

/**
 * Bounces a request with CAS authentication. If the user's session is not
 * already validated with CAS, their request will be redirected to the CAS
 * login page.
 */
CASAuthentication.prototype.bounce_redirect = function(req, res, next) {

    // Handle the request with the bounce authorization type.
    this._handle(req, res, next, AUTH_TYPE.BOUNCE_REDIRECT);
};

/**
 * Blocks a request with CAS authentication. If the user's session is not
 * already validated with CAS, they will receive a 401 response.
 */
CASAuthentication.prototype.block = function(req, res, next) {

    // Handle the request with the block authorization type.
    this._handle(req, res, next, AUTH_TYPE.BLOCK);
};

/**
 * Handle a request with CAS authentication.
 */
CASAuthentication.prototype._handle = function(req, res, next, authType) {
    if (req.path == proxyCbUrl){
      var pgtId = req.query.pgtId;
      var pgtIou = req.query.pgtIou;
      if ( pgtId && pgtIou ){
        proxyTokens[pgtIou] = pgtId;
        res.send('OK');
        return;
      } else {
        // cas checks health without parameter
        res.send('OK');
        return;
      }
    }

    // If the session has been validated with CAS, no action is required.
    if (req.session[ this.session_name ]) {
        // If this is a bounce redirect, redirect the authenticated user.
        if (authType === AUTH_TYPE.BOUNCE_REDIRECT) {
            res.redirect(req.session.cas_return_to || DEFAULT_REDIRECT_PATH);
        }
        // Otherwise, allow them through to their request.
        else {
            next();
        }
    }
    // If dev mode is active, set the CAS user to the specified dev user.
    else if (this.is_dev_mode) {
        req.session[ this.session_name ] = this.dev_mode_user;
        req.session[ this.session_info ] = this.dev_mode_info;
        next();
    }
    // If the authentication type is BLOCK, simply send a 401 response.
    else if (authType === AUTH_TYPE.BLOCK) {
        res.sendStatus(401);
    }
    // If there is a CAS ticket in the query string, validate it with the CAS server.
    else if (req.query && req.query.ticket) {
        this._handleTicket(req, res, next);
    }
    // Otherwise, redirect the user to the CAS login.
    else {
        this._login(req, res, next);
    }
};

/**
 * Redirects the client to the CAS login.
 */
CASAuthentication.prototype._login = function(req, res, next) {

    // Save the return URL in the session. If an explicit return URL is set as a
    // query parameter, use that. Otherwise, just use the URL from the request.
    // req.session.cas_return_to = req.query.returnTo || url.parse(req.url).path;
    var redirectUri = this.service_url + url.parse(req.url).path;
    req.session.cas_return_to = redirectUri;

    // Set up the query parameters.
    var query = {
        service: redirectUri
    };

    if (this.renew === true) {
        query.renew = true;
    }

    // Redirect to the CAS login.
    res.redirect( this.cas_url + url.format({
        pathname: '/login',
        query: query
    }));
};

/**
 * Logout the currently logged in CAS user.
 */
CASAuthentication.prototype.logout = function(req, res, next) {

  if (req.originalMethod === 'POST') {
    var xmlReq = req.body.logoutRequest;
    var jsonReq = xml2json.parser(xmlReq);
    var serviceTicket = jsonReq['samlp%3alogoutrequest']['samlp%3asessionindex'];

    var sid = sessionMap.get(serviceTicket);
    req.sessionStore.length((err, len) => {
      if (err) {
        console.error("error for length: " + err)
      }
      console.log("session store contains " + len + " elements")
    })
    sessionMap.delete(serviceTicket)
    req.sessionStore.destroy(sid, (err) => {
      if (err) {
          console.error("error for destroy: " + err)
      }
    })
    console.log("session map contains " + sessionMap.size + " elements")
    res.sendStatus(200);
    return;
  }
  // Destroy the entire session if the option is set.
  if (this.destroy_session) {
    req.session.destroy(function(err) {
      if (err) {
        console.log(err);
      }
    });
  }
  // Otherwise, just destroy the CAS session variables.
  else {
    delete req.session[this.session_name];
    if (this.session_info) {
      delete req.session[this.session_info];
    }
  }

  // Redirect the client to the CAS logout.
  res.redirect(this.cas_url + '/logout');
};

/*
 * Delete all entries of sessionMap for the given session id
 */
CASAuthentication.prototype.deleteSid = function (sid) {
    console.log("delete entry with sid " + sid)
    sessionMap.forEach((value, key, map) => {
        if (value === sid) {
            map.delete(key)
        }
    })
};

/**
 * Handles the ticket generated by the CAS login requester and validates it with the CAS login acceptor.
 */
CASAuthentication.prototype._handleTicket = function(req, res, next) {
    
    var ticket = req.query.ticket;
    console.log("set ticket in sessionMap: " + ticket + " with sessionID: " + req.sessionID);
    sessionMap.set(ticket, req.sessionID);
    var requestOptions = {
        host: this.cas_host,
        port: this.cas_port,
    };

    if (['1.0', '2.0', '3.0'].indexOf(this.cas_version) >= 0){
        requestOptions.method = 'GET';

        var q = {
            service: this.service_url + url.parse(req.url).pathname,
            ticket: req.query.ticket
        };

        if (this.proxyCallback_url){
          q.pgtUrl = this.proxyCallback_url;
        }

        requestOptions.path = url.format({
            pathname: this.cas_path + this._validateUri,
            query: q
        });
    }
    else if (this.cas_version === 'saml1.1'){
        var now = new Date();
        var post_data = '<?xml version="1.0" encoding="utf-8"?>\n' +
                        '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">\n' +
                        '  <SOAP-ENV:Header/>\n' +
                        '  <SOAP-ENV:Body>\n' +
                        '    <samlp:Request xmlns:samlp="urn:oasis:names:tc:SAML:1.0:protocol" MajorVersion="1"\n' +
                        '      MinorVersion="1" RequestID="_' + req.host + '.' + now.getTime() + '"\n' +
                        '      IssueInstant="' + now.toISOString() + '">\n' +
                        '      <samlp:AssertionArtifact>\n' +
                        '        ' + req.query.ticket + '\n' +
                        '      </samlp:AssertionArtifact>\n' +
                        '    </samlp:Request>\n' +
                        '  </SOAP-ENV:Body>\n' +
                        '</SOAP-ENV:Envelope>';

        requestOptions.method = 'POST';
        requestOptions.path = url.format({
            pathname: this.cas_path + this._validateUri,
            query : {
                TARGET : this.service_url + url.parse(req.url).pathname,
                ticket: ''
            }
        });
        requestOptions.headers = {
            'Content-Type': 'text/xml',
            'Content-Length': Buffer.byteLength(post_data)
        };
    }

    var request = this.request_client.request(requestOptions, function(response) {
        response.setEncoding( 'utf8' );
        var body = '';
        response.on( 'data', function(chunk) {
            return body += chunk;
        }.bind(this));
        response.on('end', function() {
            this._validate(body, function(err, user, attributes, proxyGrantingTicket) {
                if (err) {
                    console.log(err);
                    res.sendStatus(401);
                }
                else {
                    req.session[ this.session_name ] = user;
                    if (this.session_info) {
                        req.session[ this.session_info ] = attributes || {};
                    }
                    if (proxyGrantingTicket && this.proxyCallback_url){
                        var pgt = proxyTokens[proxyGrantingTicket];
                        delete proxyTokens[proxyGrantingTicket];
                        req.session [ 'pgt' ] = pgt;
                        res.redirect(req.session.cas_return_to || DEFAULT_REDIRECT_PATH);
                    } else{
                      res.redirect(req.session.cas_return_to || DEFAULT_REDIRECT_PATH);
                    }
                }
            }.bind(this));
        }.bind(this));
        response.on('error', function(err) {
            console.log('Response error from CAS: ', err);
            res.sendStatus(401);
        }.bind(this));
    }.bind(this));

    request.on('error', function(err) {
        console.log('Request error with CAS: ', err);
        res.sendStatus(401);
    }.bind(this));

    if (this.cas_version === 'saml1.1') {
        request.write(post_data);
    }
    request.end();
};

CASAuthentication.prototype.getProxyTicket = function(pgt, targetService) {
    var self = this;

    var options = {
        uri: this.cas_url + '/proxy',
        qs: {
            pgt: pgt,
            targetService: targetService
        }
    };

    return client(options).then(function(xml) {
        var json = xml2json.parser(xml);
        var pt = json['cas%3aserviceresponse']['cas%3aproxysuccess']['cas%3aproxyticket'];
        return pt;
    }).catch(function(err) {
        console.log("proxy ticket error: " + err);
    });
}

module.exports = CASAuthentication;
