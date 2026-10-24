const express = require('express');
const { imageCacheRoots } = require('./imageCacheRecovery');

/** Upload routes and previews must use the same current storage settings. */
function createStaticMediaMiddleware(config) {
  const handlers = new Map();
  return (req, res, next) => {
    const roots = imageCacheRoots(config);
    let index = 0;
    const serveNext = error => {
      if (error) return next(error);
      const root = roots[index++];
      if (!root) return next();
      if (!handlers.has(root)) handlers.set(root, express.static(root));
      handlers.get(root)(req, res, serveNext);
    };
    serveNext();
  };
}

module.exports = { createStaticMediaMiddleware };
