var logger = require('log4js').getLogger('WidgetManager');
var fs = require('fs');
var path = require('path');
var async = require('async');
var services = require('../services');
var managers = require('../managers');
var conf = require('../Conf');


exports.play = function (widgetId, poolKey, playCallback) {

    // TODO : add different download destination per widget
    // TODO : make sure it's absolute using path.resolve()
    var executionDownloadsPath, executionLogsPath, widget, executionObjectId, nodeModel;

    async.waterfall([

            function getWidget(callback) {
                logger.trace('-play- getWidget');
                managers.db.connect('widgets', function (db, collection, done) {
                    collection.findOne({ _id: managers.db.toObjectId(widgetId) }, function (err, result) {
                        if (!!err) {
                            logger.error('unable to find widget', err);
                            callback(err);
                            done();
                            return;
                        }

                        if (!result) {
                            logger.error('result is null for widget find');
                            callback(new Error('could not find widget'));
                            done();
                            return;
                        }

                        widget = result;
                        callback(null, result);
                        done();
                    });
                });
            },

            function createExecutionModel(result, callback) {
                logger.trace('-play- createExecutionModel');

                managers.db.connect('widgetExecutions', function (db, collection, done) {
                    // instantiate the execution model with the widget data
                    collection.insert(widget, function (err, docsInserted) {
                        if (!!err) {
                            logger.error('failed creating widget execution model', err);
                            callback(err);
                            done();
                            return;
                        }
                        if (!docsInserted) {
                            logger.error('no widget execution docs inserted to database');
                            callback(new Error('no widget execution docs inserted to database'));
                            done();
                            return;
                        }
                        executionObjectId = docsInserted[0]._id;
                        callback(null, executionObjectId);
                        done();
                    });
                });
            },

            function updateExecutionModel(result, callback) {
                logger.trace('-play- updateExecutionModel');

                logger.info('execution ObjectId is [%s]', result);
                // now that we have an auto generated model id, insert new fields based on it
                managers.db.connect('widgetExecutions', function (db, collection, done) {
                    executionDownloadsPath = path.join(conf.downloadsDir, result.toHexString());
                    executionLogsPath = path.join(conf.logsDir, result.toHexString());
                    collection.update(
                        { _id: result },
                        {
                            $set: {
                                downloadsPath: executionDownloadsPath,
                                logsPath: executionLogsPath
                            }
                        },
                        function (err, nUpdated) {
                            if (err) {
                                logger.error('failed updating widget execution model', err);
                                callback(err);
                                done();
                                return;
                            }
                            if (!nUpdated) {
                                logger.error('no widget execution docs updated in the database');
                                callback(new Error('no widget execution docs updated in the database'));
                                done();
                                return;
                            }
                            callback(null, result);
                            done();
                        });
                });
            },

            function downloadRecipe(result, callback) {
                logger.trace('-play- downloadRecipe');

                // TODO : add validation if destination download not already exists otherwise simply call callback.
                logger.info('downloading recipe from ', widget.recipeUrl);
                // download recipe zip
                var options = {
                    destDir: executionDownloadsPath,
                    recipeUrl: widget.recipeUrl
                };
                services.dl.downloadRecipe(options, function () {
                    callback(null, result);
                });
            },

            function TBDValidateRecipeExists(result, callback) {
                logger.trace('TBD - validate groovy file exists');

                // TODO - validate that -{service|application}.groovy file exists in expected location.
                callback(null, result);
            },

            function occupyMachine(result, callback) {
                logger.trace('-play- occupyMachine');

                managers.poolClient.occupyPoolNode(poolKey, widget.poolId, callback);
            },

            function handleOccupyMachine(result, callback) {
                logger.trace('-play- handleOccupyMachine');

                if (!result) {
                    logger.error('result is null for occupy node');
                    callback(new Error('could not occupy node, no bootstrapped nodes found'));
                    return;
                }

                try {
                    nodeModel = JSON.parse(result);
                } catch (e) {
                    callback(e);
                }

                callback(null, result);
            },

            function runCliCommand(result, callback) {
                logger.trace('-play- runCliCommand');

                var command = {
                    arguments: [
                        'connect',
                        nodeModel.machineSshDetails.publicIp,
                        ';',
                        widget.recipeType.installCommand,
                        path.join(executionDownloadsPath, widget.recipeRootPath)
                    ],
                    logsDir: executionLogsPath
                };
                // we want to remove the execution model when the execution is over
                services.cloudifyCli.executeCommand(command, function (exErr, exResult) {
                    if (!!exErr) {
                        logger.error(exErr);
                    }
                    // TODO change execution status
                });

                callback(null, executionObjectId.toHexString());
            }

        ],


        function (err, result) {
            logger.trace('-play- finished!');
            logger.info('result is ', result);

            if (!!err) {
                logger.error('failed to play widget with id [%s]', widgetId);
                _removeExecutionModel(executionObjectId, playCallback);
                playCallback(err);
                return;
            }

            playCallback(null, result);
        }
    );


};

exports.stop = function (executionId, callback) {
    _removeExecutionModel(executionId, callback);
};

exports.getStatus = function (executionId, callback) {

    managers.db.connect('widgetExecutions', function (db, collection, done) {
        collection.findOne({_id: managers.db.toObjectId(executionId)}, function (err, result) {

            logger.info('get status result: ', result);
            if (!!err) {
                callback(err);
                done();
                return;
            }

            if (!result) {
                callback(null, {state: 'STOPPED'});
                done();
                return;
            }

            callback(null, {state: 'RUNNING'});
            done();
        });
    });

};

exports.getOutput = function (executionId, callback) {
    _readOutputLog(executionId, callback);
};

function _readOutputLog (executionId, callback) {
    _readLog(executionId, services.logs.getOutput, callback);
};

function _readStatusLog (executionId, callback) {
    _readLog(executionId, services.logs.getStatus, callback);
};


function _removeExecutionModel(executionId, callback) {
    var executionObjectId;
    try {
        // make sure it's an ObjectID and not an ID string
        executionObjectId = managers.db.toObjectId(executionId);
    } catch (e) {
        callback(e);
        return;
    }

    logger.info('removing execution model with id [%s]', executionObjectId.toHexString());
    managers.db.connect('widgetExecutions', function (db, collection, done) {
        collection.remove({ _id: executionObjectId }, function (err, result) {

            if (!!err) {
                callback(err);
                done();
                return;
            }

            if (!result) {
                callback(new Error('unable to remove execution model'));
                done();
                return;
            }

            callback(null, result);
            done();
        });
    });
}

function _readLog (executionId, logFn, callback) {
    managers.db.connect('widgetExecutions', function (db, collection, done) {
        collection.findOne({_id: managers.db.toObjectId(executionId)}, function (err, result) {

            if (!!err) {
                callback(err);
                done();
                return;
            }

            if (!result) {
                callback(new Error('unable to get log. cannot find execution model with id [' + executionId + ']'));
                done();
                return;
            }

            logFn(executionId, callback);
            done();
        });
    });
};















