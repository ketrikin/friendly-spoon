// UI for the query builder. State lives in `state`; every change re-renders the
// affected panes and is autosaved to localStorage.
(function () {
  'use strict';

  const { SCHEMA_QUERY, parseSchemaText, demoSchema } = window.SchemaTools;
  const Sql = window.SqlGen;

  const STORE = { schema: 'sqb.schema', query: 'sqb.query', saved: 'sqb.saved' };

  const $ = sel => document.querySelector(sel);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function emptyQuery() {
    return {
      from: null, joins: [], select: [], where: [], orderBy: [], distinct: false, top: '', offset: '',
      version: '2017', rollup: false, into: '', vars: [],
      dedupe: { on: false, partition: [''], orderCol: '', orderDir: 'DESC' },
    };
  }

  // New rows added from the builder.
  const TEMPLATES = {
    column: () => ({ kind: 'column', col: '', agg: '', fn: '', args: [], as: '' }),
    count: () => ({ kind: 'column', col: '*', agg: 'COUNT', fn: '', args: [], as: 'RowCount' }),
    concat: () => ({ kind: 'column', col: '', agg: 'STRING_AGG', fn: '', args: [], as: '', sep: ', ', distinct: false, aggOrderCol: '', aggOrderDir: 'ASC' }),
    expr: () => ({ kind: 'expr', expr: '', isAgg: false, as: '' }),
    case: () => ({ kind: 'case', whens: [TEMPLATES.when()], else: '', as: '' }),
    when: () => ({ col: '', fn: '', args: [], op: '=', value: '', value2: '', then: '' }),
    window: () => ({ kind: 'window', wfn: 'ROW_NUMBER', col: '', n: '', partition: [''], wOrderCol: '', wOrderDir: 'ASC', frame: 'running', as: 'RowNum' }),
    filter: () => ({ conj: 'AND', agg: '', col: '', fn: '', args: [], op: '=', value: '', value2: '' }),
    order: () => ({ col: '', agg: '', dir: 'ASC' }),
    variable: () => ({ name: '', type: 'int', value: '' }),
    ref: () => '',
  };

  const state = {
    schema: load(STORE.schema) || demoSchema(),
    query: Object.assign(emptyQuery(), load(STORE.query) || {}),
    filter: '',
    expanded: {},
    suggestions: [],
  };

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
  }
  function persist() {
    store(STORE.query, state.query);
  }

  // ---------- Query helpers ----------

  const instances = () => Sql.instances(state.query);
  const tableOf = key => state.schema.tables[key];
  const displayName = key => {
    const t = tableOf(key);
    return t ? t.schema + '.' + t.name : key;
  };

  function makeAlias(key) {
    const t = tableOf(key);
    const name = t ? t.name : key.split('.').pop();
    let base = (name.match(/[A-Z]/g) || []).join('').toLowerCase();
    if (!base) base = name.replace(/[^A-Za-z]/g, '').slice(0, 1).toLowerCase() || 't';
    const used = new Set(instances().map(i => i.alias));
    let alias = base;
    for (let n = 2; used.has(alias); n++) alias = base + n;
    return alias;
  }

  // Foreign-key joins from tables already in the query to tables not yet in it.
  function joinSuggestions() {
    const out = [];
    const insts = instances();
    const inQuery = new Set(insts.map(i => i.table));
    insts.forEach(inst => {
      const t = tableOf(inst.table);
      if (!t) return;
      t.columns.forEach(c => c.refs.forEach(ref => {
        if (tableOf(ref.table) && !inQuery.has(ref.table)) {
          out.push({ table: ref.table, newCol: ref.column, alias: inst.alias, existingCol: c.name });
        }
      }));
      Object.values(state.schema.tables).forEach(other => {
        if (inQuery.has(other.key)) return;
        other.columns.forEach(c => c.refs.forEach(ref => {
          if (ref.table === inst.table) out.push({ table: other.key, newCol: c.name, alias: inst.alias, existingCol: ref.column });
        }));
      });
    });
    return out;
  }

  function addJoin(key, suggestion) {
    const alias = makeAlias(key);
    let on = [{ l: '', r: '' }];
    const s = suggestion || joinSuggestions().find(x => x.table === key);
    if (s) on = [{ l: alias + '.' + s.newCol, r: s.alias + '.' + s.existingCol }];
    state.query.joins.push({ type: 'INNER', table: key, alias, on });
    return alias;
  }

  function useTable(key) {
    if (!state.query.from) {
      state.query.from = { table: key, alias: makeAlias(key) };
      return state.query.from.alias;
    }
    return addJoin(key);
  }

  function useColumn(key, col) {
    const inst = instances().find(i => i.table === key);
    const alias = inst ? inst.alias : useTable(key);
    state.query.select.push(Object.assign(TEMPLATES.column(), { col: alias + '.' + col }));
  }

  // Properties that hold an "alias.Column" reference, and those that hold free-form SQL.
  const REF_KEYS = new Set(['col', 'l', 'r', 'aggOrderCol', 'wOrderCol', 'orderCol']);

  // Calls fn(container, key) for every column reference in the query (including the
  // entries of `partition` arrays), and rawFn(container, key) for free-form SQL text.
  function eachRef(fn, rawFn) {
    const visit = obj => {
      if (!obj || typeof obj !== 'object') return;
      Object.keys(obj).forEach(k => {
        const v = obj[k];
        if (typeof v === 'string') {
          if (REF_KEYS.has(k)) fn(obj, k);
          else if (rawFn && (k === 'expr' || (k === 'value' && Sql.RAW_VALUE_OPS.has(obj.op)))) rawFn(obj, k);
        } else if (k === 'partition' && Array.isArray(v)) {
          v.forEach((_, i) => fn(v, i));
        } else {
          visit(v);
        }
      });
    };
    visit(state.query.select);
    visit(state.query.where);
    visit(state.query.orderBy);
    visit(state.query.joins);
    visit(state.query.dedupe);
  }

  function renameAlias(oldAlias, raw) {
    const alias = String(raw).trim().replace(/[^A-Za-z0-9_]/g, '');
    if (!alias || /^\d/.test(alias) || alias === oldAlias) return false;
    if (instances().some(i => i.alias === alias)) { toast('Alias "' + alias + '" is already in use'); return false; }
    const q = state.query;
    if (q.from.alias === oldAlias) q.from.alias = alias;
    q.joins.forEach(j => { if (j.alias === oldAlias) j.alias = alias; });
    const re = new RegExp('(^|[^\\w@#.])' + oldAlias + '\\.', 'g');
    eachRef((obj, prop) => {
      if (obj[prop] && obj[prop].startsWith(oldAlias + '.')) obj[prop] = alias + obj[prop].slice(oldAlias.length);
    }, (obj, prop) => {
      obj[prop] = obj[prop].replace(re, (m, pre) => pre + alias + '.');
    });
    return true;
  }

  function removeJoin(index) {
    const q = state.query;
    const alias = q.joins[index].alias;
    q.joins.splice(index, 1);
    const uses = ref => ref && ref.startsWith(alias + '.');
    q.select = q.select.filter(s => Sql.itemKind(s) !== 'column' || !uses(s.col));
    q.where = q.where.filter(w => !uses(w.col));
    q.orderBy = q.orderBy.filter(o => !uses(o.col));
    eachRef((obj, prop) => { if (uses(obj[prop])) obj[prop] = ''; });
  }

  // ---------- Rendering ----------

  function options(list, selected) {
    return list.map(([v, label]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');
  }

  function columnOptions(selected, { star = false, outputs = false, placeholder = 'Choose column…' } = {}) {
    let html = `<option value="">${esc(placeholder)}</option>`;
    if (star) html += `<option value="*"${selected === '*' ? ' selected' : ''}>* (all columns)</option>`;
    if (outputs) {
      // Named output columns (calculated, CASE, window …) can be sorted on by name.
      const names = state.query.select.filter(it => Sql.itemKind(it) !== 'column' || it.agg || it.fn)
        .map(it => it.as && it.as.trim()).filter(Boolean);
      if (names.length) {
        html += '<optgroup label="Output columns">' + names.map(n => {
          const v = 'out:' + n;
          return `<option value="${esc(v)}"${selected === v ? ' selected' : ''}>${esc(n)}</option>`;
        }).join('') + '</optgroup>';
      }
    }
    instances().forEach(inst => {
      const t = tableOf(inst.table);
      html += `<optgroup label="${esc(inst.alias + ' — ' + displayName(inst.table))}">`;
      if (star) {
        const v = inst.alias + '.*';
        html += `<option value="${esc(v)}"${selected === v ? ' selected' : ''}>${esc(inst.alias)}.*</option>`;
      }
      (t ? t.columns : []).forEach(c => {
        const v = inst.alias + '.' + c.name;
        html += `<option value="${esc(v)}"${selected === v ? ' selected' : ''}>${esc(inst.alias + '.' + c.name)}</option>`;
      });
      html += '</optgroup>';
    });
    // Keep a reference that no longer resolves visible rather than silently dropping it.
    if (selected && !html.includes(`value="${esc(selected)}"`)) {
      html += `<option value="${esc(selected)}" selected>${esc(selected)} (missing)</option>`;
    }
    return html;
  }

  function tableOptions(placeholder) {
    return `<option value="">${esc(placeholder)}</option>` + Object.keys(state.schema.tables).sort()
      .map(k => `<option value="${esc(k)}">${esc(displayName(k))}</option>`).join('');
  }

  function renderSchema() {
    const f = state.filter.trim().toLowerCase();
    const used = new Set(instances().map(i => i.table));
    const tables = Object.values(state.schema.tables).sort((a, b) => a.key.localeCompare(b.key));
    let html = '<ul>';
    let shown = 0;
    tables.forEach(t => {
      const tableMatch = !f || t.key.toLowerCase().includes(f);
      const cols = tableMatch ? t.columns : t.columns.filter(c => c.name.toLowerCase().includes(f));
      if (!tableMatch && !cols.length) return;
      shown++;
      const open = state.expanded[t.key] || (f && !tableMatch);
      html += `<li class="${used.has(t.key) ? 'in-query' : ''}">
        <div class="table-row">
          <button class="toggle" data-action="toggle-table" data-key="${esc(t.key)}" title="Show columns">${open ? '▾' : '▸'}</button>
          <button class="table-name" data-action="use-table" data-key="${esc(t.key)}" title="Add ${esc(t.key)} to the query">
            <span class="schema-prefix">${esc(t.schema)}.</span>${esc(t.name)}</button>
          <span class="count">${t.columns.length}</span>
        </div>`;
      if (open) {
        html += '<ul class="cols">' + cols.map(c => `<li><button class="col-btn" data-action="use-column" data-key="${esc(t.key)}" data-col="${esc(c.name)}"
            title="Add to SELECT${c.refs.length ? ' — references ' + esc(c.refs.map(r => r.table + '.' + r.column).join(', ')) : ''}">
            ${c.pk ? '<span class="badge pk">PK</span>' : ''}${c.refs.length ? '<span class="badge fk">FK</span>' : ''}
            <span>${esc(c.name)}</span><span class="type">${esc(c.type)}${c.nullable ? '?' : ''}</span></button></li>`).join('') + '</ul>';
      }
      html += '</li>';
    });
    html += '</ul>';
    $('#schema-tree').innerHTML = shown ? html : '<p class="empty">No matching tables.</p>';
  }

  function renderBuilder() {
    const q = state.query;
    if (!q.from) {
      $('#builder').innerHTML = `<div class="card">
        <h3>Start a query</h3>
        <p class="placeholder">Click a table in the schema panel, or choose one here:</p>
        <select data-action="set-from">${tableOptions('Choose a table…')}</select>
        <p class="hint">Click a table name to add it (later tables are joined automatically using foreign keys).
          Click a column to add it to the SELECT list.</p>
      </div>`;
      return;
    }

    state.suggestions = joinSuggestions();
    const joinTypes = Sql.JOIN_TYPES.map(t => [t, t + ' JOIN']);

    const tablesCard = `<div class="card">
      <div class="card-head"><h3>Tables</h3></div>
      <div class="row">
        <span class="kw">FROM</span><span class="tname">${esc(displayName(q.from.table))}</span>
        <span class="muted">AS</span><input class="alias" value="${esc(q.from.alias)}" data-alias="${esc(q.from.alias)}" title="Alias">
        <button class="icon" data-action="new-query" title="Start over">✕</button>
      </div>
      ${q.joins.map((j, ji) => `<div class="join">
        <div class="row">
          <select data-path="joins.${ji}.type">${options(joinTypes, j.type)}</select>
          <span class="tname">${esc(displayName(j.table))}</span>
          <span class="muted">AS</span><input class="alias" value="${esc(j.alias)}" data-alias="${esc(j.alias)}" title="Alias">
          <button class="icon" data-action="remove-join" data-index="${ji}" title="Remove table">✕</button>
        </div>
        ${j.type === 'CROSS' ? '' : `<div class="on-rows">
          ${j.on.map((o, oi) => `<div class="row">
            <span class="kw">${oi ? 'AND' : 'ON'}</span>
            <select class="col" data-path="joins.${ji}.on.${oi}.l">${columnOptions(o.l)}</select>
            <span>=</span>
            <select class="col" data-path="joins.${ji}.on.${oi}.r">${columnOptions(o.r)}</select>
            ${j.on.length > 1 ? `<button class="icon" data-action="remove-on" data-index="${ji}" data-sub="${oi}" title="Remove condition">✕</button>` : ''}
          </div>`).join('')}
          <button class="link" data-action="add-on" data-index="${ji}">+ condition</button>
        </div>`}
      </div>`).join('')}
      <div class="suggestions">
        ${state.suggestions.length ? '<span class="label">Suggested joins:</span>' : ''}
        ${state.suggestions.map((s, i) => `<button class="suggestion" data-action="add-suggested-join" data-index="${i}"
            title="JOIN ${esc(displayName(s.table))} ON ${esc(s.newCol)} = ${esc(s.alias + '.' + s.existingCol)}">
            + ${esc(displayName(s.table))} <span class="muted">(${esc(s.newCol)} = ${esc(s.alias + '.' + s.existingCol)})</span></button>`).join('')}
        <select data-action="add-any-join">${tableOptions('Join another table…')}</select>
      </div>
    </div>`;

    $('#builder').innerHTML = tablesCard + selectCard(q) + filterCard(q) + orderCard(q) + advancedCard(q);
  }

  const DIRS = [['ASC', 'Ascending'], ['DESC', 'Descending']];

  // Function dropdown plus inputs for the chosen function's arguments.
  function fnPicker(path, src) {
    let groups = '';
    let current = '';
    Sql.FUNCTIONS.forEach(f => {
      if (f.group !== current) {
        groups += (current ? '</optgroup>' : '') + `<optgroup label="${esc(f.group)}">`;
        current = f.group;
      }
      groups += `<option value="${esc(f.id)}"${src.fn === f.id ? ' selected' : ''}>${esc(f.label)}</option>`;
    });
    let html = `<select class="fn" data-path="${path}.fn" title="Apply a function to the column">
      <option value="">ƒ none</option>${groups}</optgroup></select>`;
    const f = src.fn && Sql.FUNCTIONS.find(x => x.id === src.fn);
    (f && f.args || []).forEach((a, i) => {
      const v = (src.args || [])[i];
      const val = v == null || v === '' ? (a.def || '') : v;
      const p = `${path}.args.${i}`;
      if (a.kind === 'datepart') {
        html += `<select data-path="${p}" title="${esc(a.label)}">${options(Sql.DATE_PARTS.map(d => [d, d]), val)}</select>`;
      } else if (a.kind === 'style') {
        html += `<select data-path="${p}" title="${esc(a.label)}">${options(Sql.DATE_STYLES.map(([k, l]) => [k, l]), val)}</select>`;
      } else {
        html += `<input class="${a.kind === 'int' ? 'num' : 'value'}" placeholder="${esc(a.label)}" title="${esc(a.label)}"
          data-path="${p}" value="${esc(val)}">`;
      }
    });
    return html;
  }

  function itemControls(i) {
    return `<span class="controls"><button class="icon" data-action="move" data-list="select" data-index="${i}" data-dir="-1" title="Move up">↑</button>
      <button class="icon" data-action="move" data-list="select" data-index="${i}" data-dir="1" title="Move down">↓</button>
      <button class="icon" data-action="remove" data-list="select" data-index="${i}" title="Remove">✕</button></span>`;
  }

  function asInput(path, value, placeholder = 'alias (optional)') {
    return `<span class="as-group"><span class="muted">AS</span><input class="as" placeholder="${esc(placeholder)}" data-path="${path}.as" value="${esc(value)}"></span>`;
  }

  // Column / operator / value inputs shared by filters and CASE conditions.
  function conditionInputs(path, w, { aggs = null } = {}) {
    const noCol = Sql.NO_COLUMN_OPS.has(w.op);
    const noValue = Sql.NO_VALUE_OPS.has(w.op);
    const raw = Sql.RAW_VALUE_OPS.has(w.op);
    const placeholder = w.op === 'custom' ? 'raw SQL, e.g. (a.X = 1 OR a.Y = 2)'
      : raw ? 'SELECT x.[Id] FROM [dbo].[Table] AS x WHERE …'
        : (w.op === 'IN' || w.op === 'NOT IN') ? 'a, b, c' : 'value, @var or =SQL';
    return `${noCol ? '' : `${aggs ? `<select data-path="${path}.agg" title="Aggregate (makes this a HAVING filter)">${options(aggs, w.agg)}</select>` : ''}
        <select class="col" data-path="${path}.col">${columnOptions(w.col)}</select>
        ${fnPicker(path, w)}`}
      <select data-path="${path}.op">${options(Sql.OPERATORS.map(o => [o, o]), w.op)}</select>
      ${noValue ? '' : `<input class="value${raw ? ' wide' : ''}" placeholder="${esc(placeholder)}" data-path="${path}.value" value="${esc(w.value)}">`}
      ${w.op === 'BETWEEN' ? `<span class="muted">and</span><input class="value" data-path="${path}.value2" value="${esc(w.value2)}">` : ''}`;
  }

  function columnItem(s, i) {
    const p = `select.${i}`;
    let html = `<div class="item"><div class="row">
      <select data-path="${p}.agg" title="Aggregate">${options(Sql.AGGREGATES, s.agg)}</select>
      <select class="col" data-path="${p}.col">${columnOptions(s.col, { star: true })}</select>
      ${fnPicker(p, s)}
      ${asInput(p, s.as)}
      ${itemControls(i)}
    </div>`;
    if (s.agg === 'STRING_AGG') {
      html += `<div class="row sub">
        <span class="muted">separator</span>
        <input class="sep" data-path="${p}.sep" value="${esc(s.sep == null ? ', ' : s.sep)}" title="Text placed between values">
        <label class="muted"><input type="checkbox" data-path="${p}.distinct"${s.distinct ? ' checked' : ''}> distinct values only</label>
        ${s.distinct ? '<span class="muted">(sorted by value)</span>' : `<span class="muted">order by</span>
          <select class="col" data-path="${p}.aggOrderCol">${columnOptions(s.aggOrderCol, { placeholder: '(any order)' })}</select>
          <select data-path="${p}.aggOrderDir">${options(DIRS, s.aggOrderDir)}</select>`}
      </div>`;
    }
    return html + '</div>';
  }

  function exprItem(s, i) {
    const p = `select.${i}`;
    return `<div class="item"><div class="row">
      <span class="tag">ƒx</span>
      <input class="expr" placeholder="SQL expression, e.g. CONCAT(c.[FirstName], ' ', c.[LastName])" data-path="${p}.expr" value="${esc(s.expr)}">
      <label class="muted" title="Tick if the expression uses SUM/COUNT/… so it's left out of GROUP BY">
        <input type="checkbox" data-path="${p}.isAgg"${s.isAgg ? ' checked' : ''}> aggregate</label>
      ${asInput(p, s.as, 'name')}
      ${itemControls(i)}
    </div></div>`;
  }

  function caseItem(s, i) {
    const p = `select.${i}`;
    return `<div class="item"><div class="row">
        <span class="tag">CASE</span>
        ${asInput(p, s.as, 'name')}
        ${itemControls(i)}
      </div>
      ${(s.whens || []).map((w, wi) => `<div class="row sub">
        <span class="kw">WHEN</span>
        ${conditionInputs(`${p}.whens.${wi}`, w)}
        <span class="kw">THEN</span>
        <input class="value" placeholder="result" data-path="${p}.whens.${wi}.then" value="${esc(w.then)}">
        ${s.whens.length > 1 ? `<button class="icon" data-action="remove-at" data-path="${p}.whens" data-index="${wi}" title="Remove">✕</button>` : ''}
      </div>`).join('')}
      <div class="row sub">
        <button class="link" data-action="add-to" data-path="${p}.whens" data-template="when">+ WHEN</button>
        <span class="kw">ELSE</span>
        <input class="value" placeholder="(NULL)" data-path="${p}.else" value="${esc(s.else)}">
      </div>
    </div>`;
  }

  function partitionInputs(path, list) {
    const items = list && list.length ? list : [''];
    return items.map((c, ci) => `<select class="col" data-path="${path}.${ci}">${columnOptions(c, { placeholder: '(none)' })}</select>
      ${items.length > 1 ? `<button class="icon" data-action="remove-at" data-path="${path}" data-index="${ci}" title="Remove">✕</button>` : ''}`).join('')
      + `<button class="link" data-action="add-to" data-path="${path}" data-template="ref" title="Add another column">+</button>`;
  }

  function windowItem(s, i) {
    const p = `select.${i}`;
    const w = Sql.WINDOW_FUNCTIONS.find(x => x.id === s.wfn) || Sql.WINDOW_FUNCTIONS[0];
    const wholeGroup = w.agg && s.frame !== 'running';
    return `<div class="item"><div class="row">
        <span class="tag">OVER</span>
        <select data-path="${p}.wfn">${options(Sql.WINDOW_FUNCTIONS.map(x => [x.id, x.label]), s.wfn)}</select>
        ${w.col ? `<select class="col" data-path="${p}.col">${columnOptions(s.col)}</select>` : ''}
        ${w.n ? `<input class="num" data-path="${p}.n" placeholder="${esc(w.def)}" value="${esc(s.n)}" title="${w.id === 'NTILE' ? 'Number of buckets' : 'Rows back/forward'}">` : ''}
        ${w.agg ? `<select data-path="${p}.frame">${options([['running', 'running total'], ['partition', 'total for whole group']], s.frame)}</select>` : ''}
        ${asInput(p, s.as, 'name')}
        ${itemControls(i)}
      </div>
      <div class="row sub">
        <span class="muted">per group of</span> ${partitionInputs(`${p}.partition`, s.partition)}
        ${wholeGroup ? '' : `<span class="muted">ordered by</span>
          <select class="col" data-path="${p}.wOrderCol">${columnOptions(s.wOrderCol)}</select>
          <select data-path="${p}.wOrderDir">${options(DIRS, s.wOrderDir)}</select>`}
      </div>
    </div>`;
  }

  function selectCard(q) {
    const render = { column: columnItem, expr: exprItem, case: caseItem, window: windowItem };
    return `<div class="card">
      <div class="card-head">
        <h3>Columns <span class="muted">(SELECT)</span></h3>
        <div class="opts">
          <label><input type="checkbox" data-path="distinct"${q.distinct ? ' checked' : ''}> DISTINCT</label>
          <label>TOP <input type="number" min="0" placeholder="all" data-path="top" value="${esc(q.top)}"></label>
        </div>
      </div>
      ${q.select.length ? '' : '<p class="placeholder">No columns chosen — all columns (*) will be returned. Click columns in the schema panel or add them here.</p>'}
      ${q.select.map((s, i) => render[Sql.itemKind(s)](s, i)).join('')}
      <div class="btn-row adders">
        <button class="link" data-action="add-item" data-template="column">+ column</button>
        <button class="link" data-action="add-item" data-template="count">+ COUNT(*)</button>
        <button class="link" data-action="add-item" data-template="concat" title="Combine the values from many rows into one comma-separated list per group">+ concatenate values</button>
        <button class="link" data-action="add-item" data-template="case" title="Return different values depending on conditions">+ CASE</button>
        <button class="link" data-action="add-item" data-template="window" title="Row numbers, rankings, running totals, previous/next row values">+ window function</button>
        <button class="link" data-action="add-item" data-template="expr" title="Type any SQL expression">+ calculated</button>
      </div>
      ${q.select.some(s => s.agg || s.isAgg) ? '<p class="hint">Non-aggregated columns are added to GROUP BY automatically. “Concatenate values” joins the values from all rows in each group into one text value.</p>' : ''}
    </div>`;
  }

  function filterCard(q) {
    return `<div class="card">
      <div class="card-head"><h3>Filters <span class="muted">(WHERE / HAVING)</span></h3></div>
      ${q.where.length ? '' : '<p class="placeholder">No filters. Filters with an aggregate (e.g. COUNT &gt; 5) become HAVING.</p>'}
      ${q.where.map((w, i) => `<div class="row">
        ${i ? `<select data-path="where.${i}.conj">${options([['AND', 'AND'], ['OR', 'OR']], w.conj)}</select>` : '<span class="kw">WHERE</span>'}
        ${conditionInputs(`where.${i}`, w, { aggs: Sql.FILTER_AGGREGATES })}
        <button class="icon" data-action="remove" data-list="where" data-index="${i}" title="Remove">✕</button>
      </div>`).join('')}
      <button class="link" data-action="add-to" data-path="where" data-template="filter">+ filter</button>
      ${q.where.length ? '<p class="hint">Start a value with <code>=</code> to type raw SQL, e.g. <code>=DATEADD(day, -30, GETDATE())</code>. Use <code>@name</code> for a variable.</p>' : ''}
    </div>`;
  }

  function orderCard(q) {
    return `<div class="card">
      <div class="card-head"><h3>Sort <span class="muted">(ORDER BY)</span></h3></div>
      ${q.orderBy.map((o, i) => `<div class="row">
        ${o.col && o.col.startsWith('out:') ? '' : `<select data-path="orderBy.${i}.agg" title="Aggregate">${options(Sql.FILTER_AGGREGATES, o.agg)}</select>`}
        <select class="col" data-path="orderBy.${i}.col">${columnOptions(o.col, { outputs: true })}</select>
        <select data-path="orderBy.${i}.dir">${options(DIRS, o.dir)}</select>
        <button class="icon" data-action="move" data-list="orderBy" data-index="${i}" data-dir="-1" title="Move up">↑</button>
        <button class="icon" data-action="remove" data-list="orderBy" data-index="${i}" title="Remove">✕</button>
      </div>`).join('')}
      <button class="link" data-action="add-to" data-path="orderBy" data-template="order">+ sort</button>
    </div>`;
  }

  function advancedCard(q) {
    const dd = q.dedupe;
    return `<details class="card advanced"${state.advancedOpen ? ' open' : ''}>
      <summary><h3>Advanced options</h3></summary>
      <div class="adv-grid">
        <label for="adv-version">SQL Server version</label>
        <div><select id="adv-version" data-path="version">${options([['2017', '2017 or later'], ['2016', '2016 or earlier']], q.version)}</select>
          <span class="hint">Older versions get equivalent SQL without STRING_AGG / TRIM.</span></div>

        <label>Keep first row per group</label>
        <div>
          <label><input type="checkbox" data-path="dedupe.on"${dd.on ? ' checked' : ''}> only one row for each</label>
          ${dd.on ? `<div class="row sub">${partitionInputs('dedupe.partition', dd.partition)}</div>
            <div class="row sub"><span class="muted">keep the row with the</span>
              <select data-path="dedupe.orderDir">${options([['DESC', 'highest / latest'], ['ASC', 'lowest / earliest']], dd.orderDir)}</select>
              <select class="col" data-path="dedupe.orderCol">${columnOptions(dd.orderCol)}</select></div>` : ''}
          <span class="hint">e.g. each customer's most recent order. Uses ROW_NUMBER() in a CTE.</span>
        </div>

        <label for="adv-rollup">Subtotals</label>
        <div><label><input id="adv-rollup" type="checkbox" data-path="rollup"${q.rollup ? ' checked' : ''}> add subtotal and grand-total rows (GROUP BY ROLLUP)</label></div>

        <label for="adv-offset">Skip rows</label>
        <div><input id="adv-offset" type="number" min="0" placeholder="0" data-path="offset" value="${esc(q.offset)}">
          <span class="hint">Paging: OFFSET … ROWS; TOP becomes FETCH NEXT.</span></div>

        <label for="adv-into">Save into table</label>
        <div><input id="adv-into" placeholder="#Results" data-path="into" value="${esc(q.into)}">
          <span class="hint">SELECT … INTO a temp table (#name) to use in later steps of a script.</span></div>

        <label>Variables</label>
        <div>
          ${q.vars.map((v, i) => `<div class="row">
            <span class="kw">@</span><input class="var-name" placeholder="name" data-path="vars.${i}.name" value="${esc(v.name)}">
            <input class="var-type" placeholder="type" data-path="vars.${i}.type" value="${esc(v.type)}" title="e.g. int, date, nvarchar(50)">
            <span>=</span><input class="value" placeholder="value" data-path="vars.${i}.value" value="${esc(v.value)}">
            <button class="icon" data-action="remove" data-list="vars" data-index="${i}" title="Remove">✕</button>
          </div>`).join('')}
          <button class="link" data-action="add-to" data-path="vars" data-template="variable">+ variable</button>
          <span class="hint">DECLARE @name at the top; use @name in filters.</span>
        </div>
      </div>
    </details>`;
  }

  function highlight(sql) {
    const re = /(--[^\n]*)|('(?:[^']|'')*')|(\[(?:[^\]]|\]\])*\])|(\b\d+(?:\.\d+)?\b)|(\b(?:SELECT|DISTINCT|TOP|FROM|AS|INNER|LEFT|RIGHT|FULL|OUTER|CROSS|JOIN|ON|AND|OR|NOT|WHERE|GROUP|BY|HAVING|ORDER|ASC|DESC|IN|LIKE|BETWEEN|IS|NULL|COUNT|SUM|AVG|MIN|MAX|CASE|WHEN|THEN|ELSE|END|OVER|PARTITION|WITH|INTO|DECLARE|ROWS|OFFSET|FETCH|NEXT|ONLY|ROLLUP|EXISTS|STRING_AGG|WITHIN|CAST|AS|DROP|TABLE|IF|UNBOUNDED|PRECEDING|FOLLOWING|CURRENT|ROW|FOR|XML|PATH|TYPE)\b)/g;
    let out = '';
    let last = 0;
    sql.replace(re, (m, comment, str, id, num, kw, offset) => {
      out += esc(sql.slice(last, offset));
      const cls = comment ? 'c' : str ? 's' : id ? 'i' : num ? 'n' : 'k';
      out += `<span class="${cls}">${esc(m)}</span>`;
      last = offset + m.length;
      return m;
    });
    return out + esc(sql.slice(last));
  }

  function currentSql() {
    return Sql.buildSql(state.query, state.schema);
  }

  function renderSql() {
    const { sql, warnings } = currentSql();
    $('#sql-output').innerHTML = highlight(sql);
    $('#warnings').innerHTML = warnings.map(w => `<li>${esc(w)}</li>`).join('');
    persist();
  }

  function renderAll() {
    renderSchema();
    renderBuilder();
    renderSql();
  }

  // ---------- Saved queries ----------

  function savedQueries() {
    return load(STORE.saved) || [];
  }

  function renderSaved() {
    const list = savedQueries();
    $('#saved-list').innerHTML = list.length
      ? list.map((s, i) => `<div class="saved-item">
          <span class="name">${esc(s.name)}</span>
          <span class="when">${esc(new Date(s.savedAt).toLocaleString())}</span>
          <button type="button" data-action="load-saved" data-index="${i}">Open</button>
          <button type="button" class="icon" data-action="delete-saved" data-index="${i}" title="Delete">✕</button>
        </div>`).join('')
      : '<p class="muted">No saved queries yet. Use “Save” above the SQL to keep the current query.</p>';
  }

  // ---------- Misc UI ----------

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2000);
  }

  async function copyText(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(msg);
  }

  function getPath(obj, path) {
    return path.split('.').reduce((o, p) => (o == null ? o : o[p]), obj);
  }

  // Sets a nested value, creating missing arrays/objects on the way (e.g. "select.0.args.1").
  function setPath(obj, path, value) {
    const parts = path.split('.');
    const last = parts.pop();
    parts.forEach((p, i) => {
      if (obj[p] == null) obj[p] = /^\d+$/.test(parts[i + 1] || last) ? [] : {};
      obj = obj[p];
    });
    obj[last] = value;
  }

  // ---------- Events ----------

  const actions = {
    'toggle-table': el => { state.expanded[el.dataset.key] = !state.expanded[el.dataset.key]; renderSchema(); },
    'use-table': el => { useTable(el.dataset.key); renderAll(); },
    'use-column': el => { useColumn(el.dataset.key, el.dataset.col); renderAll(); },
    'new-query': () => {
      if (state.query.from && !confirm('Clear the current query?')) return;
      state.query = emptyQuery();
      renderAll();
    },
    'remove-join': el => { removeJoin(+el.dataset.index); renderAll(); },
    'add-on': el => { state.query.joins[+el.dataset.index].on.push({ l: '', r: '' }); renderAll(); },
    'remove-on': el => { state.query.joins[+el.dataset.index].on.splice(+el.dataset.sub, 1); renderAll(); },
    'add-suggested-join': el => {
      const s = state.suggestions[+el.dataset.index];
      if (s) addJoin(s.table, s);
      renderAll();
    },
    'add-item': el => { state.query.select.push(TEMPLATES[el.dataset.template]()); renderAll(); },
    'add-to': el => {
      let list = getPath(state.query, el.dataset.path);
      if (!Array.isArray(list)) { list = []; setPath(state.query, el.dataset.path, list); }
      list.push(TEMPLATES[el.dataset.template]());
      renderAll();
    },
    'remove-at': el => { getPath(state.query, el.dataset.path).splice(+el.dataset.index, 1); renderAll(); },
    'remove': el => { state.query[el.dataset.list].splice(+el.dataset.index, 1); renderAll(); },
    'move': el => {
      const list = state.query[el.dataset.list];
      const i = +el.dataset.index;
      const j = i + +el.dataset.dir;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      renderAll();
    },
    'copy-sql': () => copyText(currentSql().sql, 'SQL copied — paste it into SSMS'),
    'download-sql': () => {
      const blob = new Blob([currentSql().sql + '\n'], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'query.sql';
      a.click();
      URL.revokeObjectURL(a.href);
    },
    'save-query': () => {
      if (!state.query.from) { toast('Nothing to save yet'); return; }
      const name = prompt('Name for this query:', displayName(state.query.from.table) + ' query');
      if (!name) return;
      const list = savedQueries().filter(s => s.name !== name);
      list.unshift({ name, savedAt: Date.now(), query: JSON.parse(JSON.stringify(state.query)) });
      store(STORE.saved, list);
      toast('Saved “' + name + '”');
    },
    'open-saved': () => { renderSaved(); $('#saved-dialog').showModal(); },
    'load-saved': el => {
      const s = savedQueries()[+el.dataset.index];
      if (!s) return;
      state.query = Object.assign(emptyQuery(), JSON.parse(JSON.stringify(s.query)));
      $('#saved-dialog').close();
      renderAll();
    },
    'delete-saved': el => {
      const list = savedQueries();
      const s = list[+el.dataset.index];
      if (!s || !confirm('Delete “' + s.name + '”?')) return;
      list.splice(+el.dataset.index, 1);
      store(STORE.saved, list);
      renderSaved();
    },
    'open-import': () => {
      $('#import-error').hidden = true;
      $('#import-dialog').showModal();
    },
    'copy-schema-query': () => copyText(SCHEMA_QUERY, 'Schema query copied'),
    'do-import': () => {
      try {
        applySchema(parseSchemaText($('#schema-input').value));
        $('#import-dialog').close();
        toast('Imported ' + Object.keys(state.schema.tables).length + ' tables');
      } catch (e) {
        $('#import-error').textContent = e.message;
        $('#import-error').hidden = false;
      }
    },
    'load-demo': () => {
      applySchema(demoSchema());
      $('#import-dialog').close();
      toast('Loaded the demo schema');
    },
    'close-dialog': el => el.closest('dialog').close(),
  };

  function applySchema(schema) {
    state.schema = schema;
    store(STORE.schema, schema);
    // Keep the current query only if all its tables exist in the new schema.
    if (instances().some(i => !schema.tables[i.table])) state.query = emptyQuery();
    state.expanded = {};
    renderAll();
  }

  document.addEventListener('click', e => {
    const el = e.target.closest('button[data-action]');
    if (!el) return;
    e.preventDefault();
    const fn = actions[el.dataset.action];
    if (fn) fn(el);
  });

  document.addEventListener('change', e => {
    const el = e.target;
    const action = el.dataset.action;
    if (action === 'set-from' && el.value) { useTable(el.value); renderAll(); return; }
    if (action === 'add-any-join' && el.value) { addJoin(el.value); renderAll(); return; }
    if (el.dataset.alias !== undefined) {
      if (!renameAlias(el.dataset.alias, el.value)) el.value = el.dataset.alias;
      renderAll();
      return;
    }
    if (el.dataset.path) {
      const path = el.dataset.path;
      setPath(state.query, path, el.type === 'checkbox' ? el.checked : el.value);
      // A different function takes different arguments: reset them to the defaults.
      if (path.endsWith('.fn')) setPath(state.query, path.replace(/fn$/, 'args'), []);
      // Changing a filter's operator: subquery/custom values aren't meaningful as plain values.
      if (path.endsWith('.op')) {
        const row = getPath(state.query, path.replace(/\.op$/, ''));
        if (Sql.NO_COLUMN_OPS.has(row.op)) { row.agg = ''; row.fn = ''; }
      }
      // Renaming an output column changes the sort choices, but only rebuild the form when
      // needed so the next click isn't lost.
      const renamed = path.endsWith('.as') && state.query.orderBy.length;
      if (el.tagName === 'SELECT' || el.type === 'checkbox' || renamed) renderAll();
      else renderSql();
    }
  });

  document.addEventListener('toggle', e => {
    if (e.target.classList && e.target.classList.contains('advanced')) state.advancedOpen = e.target.open;
  }, true);

  // Text inputs update the SQL as you type without rebuilding the form (keeps focus).
  document.addEventListener('input', e => {
    const el = e.target;
    if (el.id === 'schema-filter') { state.filter = el.value; renderSchema(); return; }
    if (el.dataset.path && el.tagName === 'INPUT' && el.type !== 'checkbox') {
      setPath(state.query, el.dataset.path, el.value);
      renderSql();
    }
  });

  $('#schema-query').innerHTML = highlight(SCHEMA_QUERY);
  renderAll();
})();
