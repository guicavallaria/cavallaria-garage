// Store do express-session no próprio SQLite: um deploy/reinício não desloga ninguém
// (antes, com a memória, todo deploy derrubava as sessões).
const session = require('express-session');

class StoreSqlite extends session.Store {
  constructor(db, { limparACadaMs = 15 * 60_000 } = {}) {
    super();
    this.db = db;
    this.stGet = db.prepare('SELECT dados, expira_em FROM sessoes WHERE sid = ?');
    this.stSet = db.prepare(`INSERT INTO sessoes (sid, dados, expira_em) VALUES (?, ?, ?)
                             ON CONFLICT(sid) DO UPDATE SET dados = excluded.dados, expira_em = excluded.expira_em`);
    this.stDel = db.prepare('DELETE FROM sessoes WHERE sid = ?');
    this.stTouch = db.prepare('UPDATE sessoes SET expira_em = ? WHERE sid = ?');
    this.stLimpar = db.prepare('DELETE FROM sessoes WHERE expira_em < ?');
    if (limparACadaMs) {
      this.timer = setInterval(() => { try { this.stLimpar.run(Date.now()); } catch (_) { /* ok */ } }, limparACadaMs);
      this.timer.unref();
    }
  }

  static expira(sess) {
    const c = sess && sess.cookie;
    if (c && c.expires) return new Date(c.expires).getTime();
    return Date.now() + ((c && c.maxAge) || 12 * 3600_000);
  }

  get(sid, cb) {
    try {
      const r = this.stGet.get(sid);
      if (!r || r.expira_em < Date.now()) return cb(null, null);
      return cb(null, JSON.parse(r.dados));
    } catch (e) { return cb(e); }
  }

  set(sid, sess, cb) {
    try { this.stSet.run(sid, JSON.stringify(sess), StoreSqlite.expira(sess)); cb && cb(null); } catch (e) { cb && cb(e); }
  }

  destroy(sid, cb) {
    try { this.stDel.run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }

  touch(sid, sess, cb) {
    try { this.stTouch.run(StoreSqlite.expira(sess), sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
}

module.exports = { StoreSqlite };
