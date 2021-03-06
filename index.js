'use strict';

module.exports = function(ServerlessPlugin, serverlessPath) {
  const path = require( 'path' ),
  SUtils = require( path.join( serverlessPath, 'utils' ) ),
  context = require( path.join( serverlessPath, 'utils', 'context' ) ),
  SCli = require( path.join( serverlessPath, 'utils', 'cli' ) ),
  express = require('express'),
  bodyParser = require('body-parser'),
  BbPromise = require( 'bluebird'),
  JSONPath = require('JSONPath');

  class Serve extends ServerlessPlugin {
    constructor(S) {
      super(S);
    }
    static getName() {
      return 'net.nopik.' + Serve.name;
    }
    registerActions() {
      this.S.addAction(this.serve.bind(this), {
        handler:       'serve',
        description:   `Exposes all lambdas as local HTTP, simulating API Gateway functionality`,
        context:       'serve',
        contextAction: 'start',
        options:       [
          {
            option:      'init',
            shortcut:    'i',
            description: 'Optional - JS file to run as custom initialization code'
          }, {
            option:      'prefix',
            shortcut:    'p',
            description: 'Optional - add URL prefix to each lambda'
          }, {
            option:      'port',
            shortcut:    'P',
            description: 'Optional - HTTP port to use, default: 1465'
          }
        ]
      });
      return BbPromise.resolve();
    }
    registerHooks() {
      return BbPromise.resolve();
    }

    _createApp() {
      let _this = this;

      this.app = express();

      if( !this.evt.port ){
        this.evt.port = 1465;
      }

      if( !this.evt.prefix ){
        this.evt.prefix = "";
      }

      if( (this.evt.prefix.length > 0) && (this.evt.prefix[this.evt.prefix.length-1] != '/') ) {
        this.evt.prefix = this.evt.prefix + "/";
      }

      this.app.get( '/__quit', function(req, res, next){
        SCli.log('Quit request received, quitting.');
        res.send({ok: true});
        _this.server.close();
      });

      this.app.use( function(req, res, next) {
        res.header('Access-Control-Allow-Origin', '*');
        next();
      });

      this.app.use(bodyParser.json({ limit: '5mb' }));

      this.app.use( function(req, res, next){
        res.header( 'Access-Control-Allow-Methods', 'GET,PUT,HEAD,POST,DELETE,OPTIONS' );
        res.header( 'Access-Control-Allow-Headers', 'Authorization,Content-Type,x-amz-date,x-amz-security-token' );

        if( req.method != 'OPTIONS' ) {
          next()
        } else {
          res.status(200).end()
        }
      });
    }

    _tryInit() {
      if( this.evt.init ){
        let handler = require( path.join( process.cwd(), this.evt.init ) );
        return( handler( this.S, this.app, this.handlers ) );
      }
    }

    _registerLambdas() {
      let _this = this;
      let functions = this.S.state.getFunctions();

      _this.handlers = {};

      return functions.forEach(function(fun) {
        /*
         _config:
         { component: 'node',
         module: 'homepage',
         function: 'index',
         sPath: 'node/homepage/index',
         fullPath: '/path/to/some/serverless/project/node/homepage/index' },
         name: 'index',
         handler: 'homepage/index/handler.handler',
         runtime: 'nodejs',
         timeout: 6,
         memorySize: 1024,
         custom: { excludePatterns: [], envVars: [] },
         endpoints:
         [ ServerlessEndpoint {
         _S: [Object],
         _config: [Object],
         path: 'homepage/index',
         method: 'GET',
         authorizationType: 'none',
         apiKeyRequired: false,
         requestParameters: {},
         requestTemplates: [Object],
         responses: [Object] } ] }
         */

        if( fun.runtime == 'nodejs' ) {
          let handlerParts = fun.handler.split('/').pop().split('.');
          let handlerPath = path.join(fun._config.fullPath, handlerParts[0] + '.js');
          let handler;

          _this.handlers[ fun.handler ] = {
            path: handlerPath,
            handler: handlerParts[ 1 ],
            definition: fun
          };

          fun.endpoints.forEach(function(endpoint){
            let epath = endpoint.path;
            let cfPath = _this.evt.prefix + epath;

            if( cfPath[ 0 ] != '/' ) {
              cfPath = '/' + cfPath;
            }

            // In worst case we have two slashes at the end (one from prefix, one from "/" lambda mount point)
            while( (cfPath.length > 1) && (cfPath[ cfPath.length - 1 ] == '/') ){
              cfPath = cfPath.substr( cfPath.length - 1 );
            }

            let cfPathParts = cfPath.split( '/' );
            cfPathParts = cfPathParts.map(function(part){
              if( part.length > 0 ) {
                if( (part[ 0 ] == '{') && (part[ part.length - 1 ] == '}') ) {
                  return( ":" + part.substr( 1, part.length - 2 ) );
                }
              }
              return( part );
            });
            if( process.env.DEBUG ) {
              SCli.log( "Route: " + endpoint.method + " " + cfPath );
            }

            _this.app[ endpoint.method.toLocaleLowerCase() ]( cfPathParts.join('/'), function(req, res, next){
              SCli.log("Serving: " + endpoint.method + " " + cfPath);
              let result = new BbPromise(function(resolve, reject) {

                let event = {};
                let prop;

                // Limited support for json input mapping
                if (endpoint.requestTemplates && endpoint.requestTemplates['application/json']) {
                  let map = endpoint.requestTemplates['application/json'];
                  let mappingKey;
                  let mappingValue;
                  let mappingResult;

                  if (typeof(map) === 'string') {
                    let jsonReplace = /\$input.json\(.+?\)/g;
                    map = map.replace(jsonReplace, '\"$&\"');
                    map = JSON.parse(map);
                  }
                  for (mappingKey in map) {
                    mappingValue = map[mappingKey];
                    try {
                      if (mappingResult = _this._processMapping(req, mappingValue)) {
                        event[mappingKey] = mappingResult;
                      }
                    } catch (err) {
                      SCli.log("Error processing input parameter '" + mappingValue + "':" + err);
                    }
                  }
                  // If no template is supplied, map all inputs from the body, params and query
                } else {
                  for( prop in req.body ) {
                    if( req.body.hasOwnProperty( prop ) ){
                      event[ prop ] = req.body[ prop ];
                    }
                  }

                  for( prop in req.params ) {
                    if( req.params.hasOwnProperty( prop ) ){
                      event[ prop ] = req.params[ prop ];
                    }
                  }

                  for( prop in req.query ) {
                    if( req.query.hasOwnProperty( prop ) ){
                      event[ prop ] = req.query[ prop ];
                    }
                  }
                }

                if( !handler ) {
                  try {
                    handler = require( handlerPath )[handlerParts[1]];
                  } catch( e ) {
                    SCli.log( "Unable to load " + handlerPath + ": " + e );
                    throw e ;
                  }
                }
                handler(event, context( fun.name, function(err, result) {
                  if (err) {
                    SCli.log(err);
                    return reject(err);
                  }
                  resolve(result);
                }));
              });

              result.then(function(r){
                res.send(r);
              }, function(err){
                SCli.log(err);
                res.sendStatus(500);
              });
            } );
          });
        }
      });
    }

    _processMapping(req, mapping) {
      // Extract the type of mapping
      let $input = new Input(req);
      let inputRegexp = /\$input\.()/;
      if (inputRegexp.test(mapping)) {
        return eval(mapping);
      } else {
        return null;
      }
    }

    _listen() {
      let _this = this;

      this.server = this.app.listen( this.evt.port, function(){
        SCli.log( "Serverless API Gateway simulator listening on http://localhost:" + _this.evt.port );
      });
    }

    serve(evt) {
      let _this = this;

      if (_this.S.cli) {
        evt = JSON.parse(JSON.stringify(this.S.cli.options));
        if (_this.S.cli.options.nonInteractive) _this.S._interactive = false
      }

      _this.evt = evt;

      return this.S.init()
        .bind(_this)
        .then(_this._createApp)
        .then(_this._registerLambdas)
        .then(_this._tryInit)
        .then(_this._listen)
        .then(function() {
          return _this.evt;
        });
    }
  }

  class Input {

    constructor(request) {
      this.request = request;
    }

    params(param) {
      if (param) {
        return this.request.params[param] || this.request.query[param] || this.request.headers[param];
      } else {
        return {
          headers: this.request.params,
          querystring: this.request.query,
          path: this.request.params
        }
      }
    }

    json(path) {
      var jsonObject = JSONPath({path: path, json: this.request.body})[0]; // Return the first match of this jsonpath
      return jsonObject;
    }

    path(path) {
      throw new Error("path input mapping method has not been implemented");
    }
  }

  return Serve;
};
