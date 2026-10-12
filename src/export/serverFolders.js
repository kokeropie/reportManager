'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const { cleanFolder, resolveUnder } = require('../subscriptions/service');

// A folder browser limited to the signed-in user's own area on the server (OUTPUT_DIR/<userId>/). Folders are
// shown and sent as relative "A/B" names, never absolute paths, so nothing outside that area can be reached.
function userRoot(outputDir, userId) {
  return resolveUnder(outputDir, String(parseInt(userId, 10)));
}

function createServerFoldersRouter({ outputDir }) {
  const r = express.Router();
  const wrap = (fn) => (req, res, next) => { try { fn(req, res); } catch (e) { next(e); } };

  r.get('/', wrap((req, res) => {
    const root = userRoot(outputDir, req.session.userId);
    const rel = cleanFolder(req.query.path);
    const abs = resolveUnder(root, rel);
    let names = [];
    try {
      names = fs.readdirSync(abs, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    } catch (e) { /* not created yet: empty */ }
    res.json({ path: rel, parent: rel ? rel.split('/').slice(0, -1).join('/') : null, folders: names, location: abs });
  }));

  r.post('/', wrap((req, res) => {
    const root = userRoot(outputDir, req.session.userId);
    const b = req.body || {};
    const rel = cleanFolder([cleanFolder(b.path), cleanFolder(b.name)].filter(Boolean).join('/'));
    if (!cleanFolder(b.name)) return res.status(400).json({ error: 'Enter a folder name' });
    fs.mkdirSync(resolveUnder(root, rel), { recursive: true });
    res.status(201).json({ path: rel });
  }));

  return r;
}

module.exports = { createServerFoldersRouter, userRoot };
