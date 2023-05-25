const log4js = require('log4js');

exports.initLogger = function (id) {
  log4js.configure({
    appenders: {
      console: {
        type: 'console',
      },
      file: {
        type: 'file',
        filename: `logs/crawler-${id}.log`,
      },
    },
    categories: {
      default: {
        appenders: ['console', 'file'],
        level: 'info'
      },
      dev: {
        appenders: ['console'],
        level: 'info'
      },
      prod: {
        appenders: ['console', 'file'],
        level: 'info'
      },
    }
  });
}

exports.logger = log4js;
