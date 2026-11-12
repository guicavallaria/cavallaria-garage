// Refaz uma tabela trocando um trecho do CREATE TABLE (ex.: a lista de um CHECK), que o SQLite não
// altera com ALTER TABLE. Mantém colunas (inclusive as que vieram de ALTERs), dados e índices.
// Use numa migração com `exports.semChavesEstrangeiras = true`: com as chaves estrangeiras ligadas,
// apagar a tabela antiga quebraria as referências de outras tabelas a ela (o runner confere tudo
// com foreign_key_check antes de gravar).
function refazerTabela(db, tabela, de, para) {
  const t = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabela);
  if (!t) throw new Error(`tabela ${tabela} não existe`);
  if (!t.sql.includes(de)) throw new Error(`trecho não encontrado no CREATE TABLE de ${tabela}: ${de}`);
  const indices = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL").all(tabela).map((i) => i.sql);
  const nova = `${tabela}__nova`;
  const sql = t.sql.replace(de, para).replace(new RegExp(`^CREATE TABLE\\s+"?${tabela}"?`), `CREATE TABLE ${nova}`);
  db.exec(sql);
  db.exec(`INSERT INTO ${nova} SELECT * FROM ${tabela}`);
  db.exec(`DROP TABLE ${tabela}`);
  db.exec(`ALTER TABLE ${nova} RENAME TO ${tabela}`);
  for (const i of indices) db.exec(i);
}

module.exports = { refazerTabela };
