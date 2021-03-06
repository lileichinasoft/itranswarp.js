// discuss api

var
    _ = require('lodash'),
    async = require('async'),
    api = require('../api'),
    db = require('../db'),
    utils = require('./_utils'),
    constants = require('../constants'),
    search = require('../search/search');

var
    Board = db.board,
    Topic = db.topic,
    Reply = db.reply,
    warp = db.warp,
    next_id = db.next_id;

function indexDiscuss(r) {
    var doc = {
        type: 'discuss',
        id: r.id,
        tags: r.tags || '',
        name: r.name,
        description: '',
        content: utils.html2text(r.content),
        created_at: r.created_at,
        updated_at: r.updated_at,
        url: '/discuss/' + (r.topic_id ? 'topics/' + r.topic_id + '/find/' + r.id : r.board_id + '/' + r.id),
        upvotes: 0
    };
    process.nextTick(function () {
        search.engine.index(doc);
    });
}

function unindexDiscuss(r) {
    process.nextTick(function () {
        search.engine.unindex({
            id: r.id
        });
    });
}

function unindexDiscussByIds(ids) {
    process.nextTick(function () {
        var
            arr = ids,
            fn = function () {
                if (arr.length > 0) {
                    if (arr.length > 10) {
                        search.engine.unindex(arr.splice(arr.length - 10, 10));
                    } else {
                        search.engine.unindex(arr.splice(0, arr.length));
                    }
                    setTimeout(fn, 500);
                }
            };
        fn();
    });
}

function getNavigationMenus(callback) {
    callback(null, [{
        name: 'Discuss',
        url: '/discuss'
    }]);
}

function getBoard(board_id, tx, callback) {
    if (arguments.length === 2) {
        callback = tx;
        tx = undefined;
    }
    Board.find(board_id, tx, function (err, board) {
        if (err) {
            return callback(err);
        }
        if (board === null) {
            return callback(api.notFound('Board'));
        }
        return callback(null, board);
    });
}

function getBoards(tx, callback) {
    if (arguments.length === 1) {
        callback = tx;
        tx = undefined;
    }
    Board.findAll({
        order: 'display_order'
    }, tx, function (err, boards) {
        if (err) {
            return callback(err);
        }
        // sort by display_order and group by tag:
        var
            lastTag = null,
            groups = [],
            tagDict = {},
            tags = _.uniq(_.map(boards, function (b) {
                return b.tag;
            }));
        _.each(tags, function (tag, index) {
            tagDict[tag] = index;
        });
        boards.sort(function (b1, b2) {
            var
                n1 = tagDict[b1.tag],
                n2 = tagDict[b2.tag];
            if (n1 === n2) {
                return 0;
            }
            return n1 < n2 ? -1 : 1;
        });
        // group:
        _.each(boards, function (b) {
            if (lastTag === b.tag) {
                groups[groups.length - 1].push(b);
            } else {
                lastTag = b.tag;
                groups.push([b]);
            }
        });
        return callback(null, groups);
    });
}

function createBoard(data, tx, callback) {
    if (arguments.length === 2) {
        callback = tx;
        tx = undefined;
    }
    Board.findNumber('max(display_order)', tx, function (err, num) {
        if (err) {
            return callback(err);
        }
        var display_order = (num === null) ? 0 : num + 1;
        Board.create({
            name: data.name,
            tag: data.tag,
            description: data.description,
            display_order: display_order
        }, tx, callback);
    });
}

function lockBoard(board_id, locked, callback) {
    getBoard(board_id, function (err, board) {
        if (err) {
            return callback(err);
        }
        if (board.locked === locked) {
            return callback(null, board);
        }
        board.locked = locked;
        board.update(callback);
    });
}

function getTopic(topic_id, tx, callback) {
    if (arguments.length === 2) {
        callback = tx;
        tx = undefined;
    }
    Topic.find(topic_id, tx, function (err, topic) {
        if (err) {
            return callback(err);
        }
        if (topic === null) {
            return callback(api.notFound('Topic'));
        }
        return callback(null, topic);
    });
}

function getTopics(board_id, page, callback) {
    Topic.findNumber({
        select: 'count(*)',
        where: 'board_id=?',
        params: [board_id]
    }, function (err, num) {
        if (err) {
            return callback(err);
        }
        page.totalItems = num;
        if (page.isEmpty) {
            return callback(null, { page: page, topics: [] });
        }
        Topic.findAll({
            select: ['id', 'board_id', 'user_id', 'name', 'tags', 'upvotes', 'downvotes', 'score', 'created_at', 'updated_at', 'version'],
            where: 'board_id=?',
            params: [board_id],
            order: 'updated_at desc',
            offset: page.offset,
            limit: page.limit
        }, function (err, entities) {
            if (err) {
                return callback(err);
            }
            return callback(null, {
                page: page,
                topics: entities
            });
        });
    });
}

function createTopic(board_id, user_id, name, tags, content, callback) {
    warp.transaction(function (err, tx) {
        if (err) {
            return callback(err);
        }
        async.waterfall([
            function (callback) {
                getBoard(board_id, tx, callback);
            },
            function (board, callback) {
                Topic.create({
                    board_id: board_id,
                    user_id: user_id,
                    name: name,
                    tags: tags,
                    content: content
                }, callback);
            },
            function (topic, callback) {
                warp.update('update boards set topics = topics + 1 where id=?', [board_id], tx, function (err, r) {
                    if (err) {
                        return callback(err);
                    }
                    return callback(null, topic);
                });
            }
        ], function (err, result) {
            tx.done(err, function (err) {
                if (err) {
                    return callback(err);
                }
                return callback(null, result);
            });
        });
    });
}

function deleteTopic(topic_id, callback) {
    var reply_ids = null;
    warp.transaction(function (err, tx) {
        if (err) {
            return callback(err);
        }
        async.waterfall([
            function (callback) {
                getTopic(topic_id, tx, callback);
            },
            function (topic, callback) {
                topic.destroy(tx, callback);
            },
            function (r, callback) {
                warp.query('select id from replies where topic_id=?', [topic_id], tx, callback);
            },
            function (rids, callback) {
                reply_ids = rids;
                warp.update('delete from replies where topic_id=?', [topic_id], tx, callback);
            }
        ], function (err, results) {
            tx.done(err, function (err) {
                if (err) {
                    return callback(err);
                }
                return callback(null, topic_id, reply_ids);
            });
        });
    });
}

function getAllReplies(page, callback) {
    Reply.findNumber({
        select: 'count(*)'
    }, function (err, num) {
        if (err) {
            return callback(err);
        }
        page.totalItems = num;
        if (num === 0) {
            return callback(null, { page: page, replies: [] });
        }
        Reply.findAll({
            order: 'id desc',
            offset: page.offset,
            limit: page.limit
        }, function (err, entities) {
            if (err) {
                return callback(err);
            }
            return callback(null, {
                page: page,
                replies: entities
            });
        });
    });
}

function getReplies(topic_id, page, callback) {
    Reply.findNumber({
        select: 'count(*)',
        where: 'topic_id=?',
        params: [topic_id]
    }, function (err, num) {
        if (err) {
            return callback(err);
        }
        // items = 1 topic + N replies:
        page.totalItems = num + 1;
        if (num === 0) {
            return callback(null, { page: page, replies: [] });
        }
        Reply.findAll({
            where: 'topic_id=?',
            params: [topic_id],
            order: 'id',
            offset: (page.pageIndex === 1) ? 0 : (page.offset - 1),
            limit: (page.pageIndex === 1) ? (page.limit - 1) : page.limit
        }, function (err, entities) {
            if (err) {
                return callback(err);
            }
            return callback(null, {
                page: page,
                replies: entities
            });
        });
    });
}

function getReplyUrl(topic_id, reply_id, callback) {
    getTopic(topic_id, function (err, topic) {
        if (err) {
            return callback(err);
        }
        Reply.findNumber({
            select: 'count(*)',
            where: 'topic_id=? and id < ?',
            params: [topic_id, reply_id]
        }, function (err, num) {
            if (err) {
                return callback(err);
            }
            var
                p = Math.floor((num + 1) / 20) + 1,
                url = '/discuss/' + topic.board_id + '/' + topic_id + '?page=' + p + '#' + reply_id;
            return callback(null, url);
        });
    });
}

function createReply(topic_id, user_id, content, callback) {
    var topic = null;
    warp.transaction(function (err, tx) {
        if (err) {
            return callback(err);
        }
        async.waterfall([
            function (callback) {
                getTopic(topic_id, tx, callback);
            },
            function (t, callback) {
                if (t.locked) {
                    return callback(api.invalidParam('id', 'Topic is locked.'));
                }
                topic = t;
                Reply.create({
                    topic_id: topic_id,
                    user_id: user_id,
                    content: content
                }, callback);
            },
            function (reply, callback) {
                warp.update('update topics set replies = replies + 1, updated_at = ? where id=?', [Date.now(), topic_id], tx, function (err, r) {
                    if (err) {
                        return callback(err);
                    }
                    return callback(null, reply);
                });
            }
        ], function (err, reply) {
            tx.done(err, function (err) {
                if (err) {
                    return callback(err);
                }
                return callback(null, topic, reply);
            });
        });
    });
}

module.exports = {

    getNavigationMenus: getNavigationMenus,

    getBoard: getBoard,

    getBoards: getBoards,

    getTopic: getTopic,

    getTopics: getTopics,

    getAllReplies: getAllReplies,

    getReplies: getReplies,

    getReplyUrl: getReplyUrl,

    'POST /api/boards': function (req, res, next) {
        /**
         * Create new board.
         * 
         * @name Create Board
         * @param {string} name - The name of the board.
         * @param {string} description - The description of the board.
         * @return {object} Board object.
         */
        if (utils.isForbidden(req, constants.ROLE_ADMIN)) {
            return next(api.notAllowed('Permission denied.'));
        }
        var name, tag, description;
        try {
            name = utils.getRequiredParam('name', req);
        } catch (e) {
            return next(e);
        }
        tag = utils.getParam('tag', '', req);
        description = utils.getParam('description', '', req);
        createBoard({
            name: name,
            tag: tag,
            description: description
        }, function (err, board) {
            if (err) {
                return next(err);
            }
            return res.send(board);
        });
    },

    'POST /api/boards/:id': function (req, res, next) {
        /**
         * Update a board.
         * 
         * @name Update Board
         * @param {string} id - The id of the board.
         * @param {string} [name] - The new name of the board.
         * @param {string} [description] - The new description of the board.
         * @return {object} Board object that was updated.
         */
        if (utils.isForbidden(req, constants.ROLE_ADMIN)) {
            return next(api.notAllowed('Permission denied.'));
        }
        var name = utils.getParam('name', req),
            tag = utils.getParam('tag', req),
            description = utils.getParam('description', req);
        if (name !== null) {
            if (name === '') {
                return next(api.invalidParam('name'));
            }
        }
        if (tag !== null) {
            if (tag === '') {
                return next(api.invalidParam('tag'));
            }
        }
        getBoard(req.params.id, function (err, entity) {
            if (err) {
                return next(err);
            }
            if (name !== null) {
                entity.name = name;
            }
            if (tag !== null) {
                entity.tag = tag;
            }
            if (description !== null) {
                entity.description = description;
            }
            entity.update(function (err, entity) {
                if (err) {
                    return next(err);
                }
                return res.send(entity);
            });
        });
    },

    'POST /api/boards/:id/lock': function (req, res, next) {
        /**
         * Lock the board by its id.
         * 
         * @name Lock Board
         * @param {string} id - The id of the board.
         * @return {object} Results contains locked id. e.g. {"id": "12345"}
         */
        if (utils.isForbidden(req, constants.ROLE_ADMIN)) {
            return next(api.notAllowed('Permission denied.'));
        }
        lockBoard(req.params.id, true, function (err, board) {
            if (err) {
                return next(err);
            }
            return res.send(board);
        });
    },

    'POST /api/boards/:id/unlock': function (req, res, next) {
        /**
         * Unlock the board by its id.
         * 
         * @name Unlock Board
         * @param {string} id - The id of the board.
         * @return {object} Results contains locked id. e.g. {"id": "12345"}
         */
        if (utils.isForbidden(req, constants.ROLE_ADMIN)) {
            return next(api.notAllowed('Permission denied.'));
        }
        lockBoard(req.params.id, false, function (err, board) {
            if (err) {
                return next(err);
            }
            return res.send(board);
        });
    },

    'POST /api/boards/all/sort': function (req, res, next) {
        /**
         * Sort boards.
         *
         * @name Sort Boards
         * @param {array} id: The ids of boards.
         * @return {object} The sort result like { "sort": true }.
         */
        if (utils.isForbidden(req, constants.ROLE_ADMIN)) {
            return next(api.notAllowed('Permission denied.'));
        }
        var i, entity, pos;
        Board.findAll(function (err, entities) {
            if (err) {
                return next(err);
            }
            var ids = req.body.id;
            if (!Array.isArray(ids)) {
                ids = [ids];
            }
            if (entities.length !== ids.length) {
                return next(api.invalidParam('id', 'Invalid id list.'));
            }
            for (i = 0; i < entities.length; i++) {
                entity = entities[i];
                pos = ids.indexOf(entity.id);
                if (pos === (-1)) {
                    return next(api.invalidParam('id', 'Invalid id parameters.'));
                }
                entity.display_order = pos;
            }
            warp.transaction(function (err, tx) {
                if (err) {
                    return next(err);
                }
                async.series(_.map(entities, function (entity) {
                    return function (callback) {
                        entity.update(['display_order', 'updated_at', 'version'], tx, callback);
                    };
                }), function (err, result) {
                    tx.done(err, function (err) {
                        if (err) {
                            return next(err);
                        }
                        return res.send({ sort: true });
                    });
                });
            });
        });
    },

    'POST /api/boards/:id/topics': function (req, res, next) {
        if (utils.isForbidden(req, constants.ROLE_SUBSCRIBER)) {
            return next(api.notAllowed('Permission denied.'));
        }
        var
            board_id = req.params.id,
            name = utils.getParam('name', null, req),
            tags = utils.formatTags(utils.getParam('tags', '', req)),
            content;
        try {
            name = utils.getRequiredParam('name', req);
            content = utils.safeMd2html(utils.getRequiredParam('content', req));
        } catch (e) {
            return next(e);
        }
        createTopic(board_id, req.user.id, name, tags, content, function (err, topic) {
            if (err) {
                return next(err);
            }
            indexDiscuss(topic);
            return res.send(topic);
        });
    },

    'POST /api/replies/:id/delete': function (req, res, next) {
        /**
         * Delete a reply by its id.
         * 
         * @name Delete Reply.
         * @param {string} id - The id of the reply.
         * @return {object} Results contains deleted id. e.g. {"id": "12345"}
         */
        if (utils.isForbidden(req, constants.ROLE_EDITOR)) {
            return next(api.notAllowed('Permission denied.'));
        }
        Reply.find(req.params.id, function (err, reply) {
            if (err) {
                return next(err);
            }
            if (reply === null) {
                return next(api.notFound('Reply'));
            }
            reply.deleted = true;
            reply.content = '';
            reply.update(function (err, entity) {
                if (err) {
                    return next(err);
                }
                unindexDiscuss(entity);
                return res.send(entity);
            });
        });
    },

    'POST /api/topics/:id/delete': function (req, res, next) {
        /**
         * Delete a topic by its id.
         * 
         * @name Delete Topic
         * @param {string} id - The id of the topic.
         * @return {object} Results contains deleted id. e.g. {"id": "12345"}
         */
        if (utils.isForbidden(req, constants.ROLE_EDITOR)) {
            return next(api.notAllowed('Permission denied.'));
        }
        deleteTopic(req.params.id, function (err, topic_id, reply_ids) {
            if (err) {
                return next(err);
            }
            var r = { id: req.params.id };
            unindexDiscuss(r);
            unindexDiscussByIds(reply_ids);
            return res.send(r);
        });
    },

    'POST /api/topics/:id/replies': function (req, res, next) {
        if (utils.isForbidden(req, constants.ROLE_SUBSCRIBER)) {
            return next(api.notAllowed('Permission denied.'));
        }
        var
            topic_id = req.params.id,
            content;
        try {
            content = utils.safeMd2html(utils.getRequiredParam('content', req));
        } catch (e) {
            return next(e);
        }
        createReply(topic_id, req.user.id, content, function (err, topic, reply) {
            if (err) {
                return next(err);
            }
            reply.name = 'Re:' + topic.name;
            indexDiscuss(reply);
            delete reply.name;
            return res.send(reply);
        });
    }

};
