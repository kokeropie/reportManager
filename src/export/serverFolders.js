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

function createServerFoldersRouter({ outputDir, subs = null }) {
  const r = express.Router();
  const wrap = (fn) => (req, res, next) => { Promise.resolve().then(() => fn(req, res)).catch(next); };

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

  // Delete a folder the user no longer needs. Only when it holds no files (empty subfolders go with it), so saved
  // reports are never lost by accident: delete or move the files first. The user's own root cannot be deleted.
  r.delete('/', wrap(async (req, res) => {
    const root = userRoot(outputDir, req.session.userId);
    const rel = cleanFolder(req.query.path);
    if (!rel) return res.status(400).json({ error: 'Choose a folder to delete' });
    const abs = resolveUnder(root, rel);
    if (!abs || !fs.existsSync(abs)) return res.status(404).json({ error: 'Folder not found' });
    const hasFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).some((d) => (d.isDirectory() ? hasFiles(path.join(dir, d.name)) : true));
    if (hasFiles(abs)) return res.status(409).json({ error: 'The folder still has files. Delete them first' });
    // Subscriptions saving here need a new folder: say so first, and hold them once the user confirms.
    const uid = parseInt(req.session.userId, 10);
    const linked = subs ? await subs.usingFolder(uid, rel) : [];
    if (linked.length && req.query.confirm !== '1') {
      return res.status(409).json({ error: 'Subscriptions save into this folder', needsConfirm: true, subscriptions: linked.map((s) => s.name) });
    }
    fs.rmSync(abs, { recursive: true });
    const held = subs ? await subs.holdForDeletedFolder(uid, rel) : [];
    res.json({ ok: true, parent: rel.split('/').slice(0, -1).join('/'), held: held.map((s) => s.name) });
  }));

  return r;
}

module.exports = { createServerFoldersRouter, userRoot };
