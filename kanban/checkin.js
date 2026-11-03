// Status do CHECK-IN (vistoria de entrada) por OS, para os relatórios semanais do PC.
// Pedido do Guilherme (03/11/2026): as fotos deixaram de ser anexadas no Onmotor — a
// conferência "fotos ✓/!" do relatório passa a ser "check-in ✓/!" pela vistoria de
// entrada do kanban. A rota fica ANTES do login (é chamada por script, como o upload
// do pós-vendas) e usa o mesmo token Bearer.

// Uma linha por card. Se a OS tiver mais de uma vistoria, vale a finalizada mais recente;
// sem nenhuma finalizada, a mais recente em andamento.
const SQL = `
  SELECT c.empresa, c.os_numero, c.os_entrada_em, c.os_inicio_em,
    (SELECT json_object('status', e.status, 'finalizado_em', e.finalizado_em,
                        'iniciado_em', e.iniciado_em, 'feito_por', e.feito_por)
       FROM kb_checklist_execucoes e
       JOIN kb_checklist_modelos m ON m.id = e.modelo_id
      WHERE e.card_id = c.id AND m.codigo = 'entrada'
      ORDER BY (e.status = 'finalizado') DESC, e.id DESC
      LIMIT 1) AS vistoria
  FROM kb_cards c
  WHERE (? IS NULL OR c.empresa = ?)
  ORDER BY c.empresa, c.os_numero`;

function statusCheckin(db, empresa = null) {
  return db.prepare(SQL).all(empresa, empresa).map((r) => {
    const v = r.vistoria ? JSON.parse(r.vistoria) : null;
    return {
      empresa: r.empresa,
      os: r.os_numero,
      entrada_em: r.os_entrada_em || r.os_inicio_em || null,
      checkin: v ? v.status : null,            // 'finalizado' | 'em_andamento' | null
      finalizado_em: v ? v.finalizado_em : null,
      iniciado_em: v ? v.iniciado_em : null,
      feito_por: v ? v.feito_por : null,
    };
  });
}

// A conferência por check-in vale para OS FINALIZADAS a partir desta data (1ª semana
// inteira com o kanban no ar); antes disso continua valendo a contagem de fotos do Onmotor.
const CHECKIN_DESDE = '2026-10-26';
// Carga inicial de cada empresa no kanban: carro que já estava na oficina antes disso
// não passou por vistoria de entrada — não é falha de operador.
const KANBAN_NO_AR = { cavallaria: '2026-10-23', awdyna: '2026-10-30' };

const isoDeBr = (d) => { const m = String(d || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
const brCurto = (iso) => { const d = new Date(iso); if (isNaN(d)) return ''; const sp = new Date(d.getTime() - 3 * 3600e3); return sp.toISOString().slice(8, 10) + '/' + sp.toISOString().slice(5, 7); };

// reg = linha de statusCheckin (ou undefined se a OS não tem card). Devolve null quando a
// OS é anterior a CHECKIN_DESDE (o relatório mostra as fotos, como antes).
// s: 'ok' | 'andamento' | 'sem' | 'semcard' | 'antes'
function classificar(empresa, finalizadoBr, reg) {
  const fin = isoDeBr(finalizadoBr);
  if (!fin || fin < CHECKIN_DESDE) return null;
  const noAr = KANBAN_NO_AR[empresa] || KANBAN_NO_AR.cavallaria;
  // sem card e finalizada antes de a empresa entrar no kanban (ex.: AWDYNA #717, 27/10)
  if (!reg) return fin < noAr ? { s: 'antes' } : { s: 'semcard' };
  if (reg.checkin === 'finalizado') return { s: 'ok', em: brCurto(reg.finalizado_em), por: reg.feito_por || '' };
  if (reg.checkin === 'em_andamento') return { s: 'andamento', por: reg.feito_por || '' };
  if (reg.entrada_em && reg.entrada_em.slice(0, 10) < noAr) return { s: 'antes' };
  return { s: 'sem' };
}

function rota({ db, token }) {
  return (req, res) => {
    if (!token || req.get('Authorization') !== 'Bearer ' + token) {
      return res.status(401).json({ erro: 'token inválido' });
    }
    const empresa = req.query.empresa ? String(req.query.empresa) : null;
    res.json({ gerado_em: new Date().toISOString(), cards: statusCheckin(db, empresa) });
  };
}

module.exports = { statusCheckin, classificar, rota, CHECKIN_DESDE, KANBAN_NO_AR };
