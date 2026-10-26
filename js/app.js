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
    return { from: null, joins: [], select: [], where: [], orderBy: [], distinct: false, top: '' };
  }

  const state = {
    schema: load(STORE.schema) || demoSchema(),
    query: load(STORE.query) || emptyQuery(),
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
    state.query.select.push({ col: alias + '.' + col, agg: '', as: '' });
  }

  // Calls fn(obj, prop) for every column-reference property in the query.
  function eachRef(fn) {
    const q = state.query;
    q.select.forEach(s => fn(s, 'col'));
    q.where.forEach(w => fn(w, 'col'));
    q.orderBy.forEach(o => fn(o, 'col'));
    q.joins.forEach(j => j.on.forEach(o => { fn(o, 'l'); fn(o, 'r'); }));
  }

  function renameAlias(oldAlias, raw) {
    const alias = String(raw).trim().replace(/[^A-Za-z0-9_]/g, '');
    if (!alias || /^\d/.test(alias) || alias === oldAlias) return false;
    if (instances().some(i => i.alias === alias)) { toast('Alias "' + alias + '" is already in use'); return false; }
    const q = state.query;
    if (q.from.alias === oldAlias) q.from.alias = alias;
    q.joins.forEach(j => { if (j.alias === oldAlias) j.alias = alias; });
    eachRef((obj, prop) => {
      if (obj[prop] && obj[prop].startsWith(oldAlias + '.')) obj[prop] = alias + obj[prop].slice(oldAlias.length);
    });
    return true;
  }

  function removeJoin(index) {
    const q = state.query;
    const alias = q.joins[index].alias;
    q.joins.splice(index, 1);
    const uses = ref => ref && ref.startsWith(alias + '.');
    q.select = q.select.filter(s => !uses(s.col));
    q.where = q.where.filter(w => !uses(w.col));
    q.orderBy = q.orderBy.filter(o => !uses(o.col));
    q.joins.forEach(j => j.on.forEach(o => { if (uses(o.l)) o.l = ''; if (uses(o.r)) o.r = ''; }));
  }

  // ---------- Rendering ----------

  function options(list, selected) {
    return list.map(([v, label]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');
  }

  function columnOptions(selected, { star = false, placeholder = 'Choose column…' } = {}) {
    let html = `<option value="">${esc(placeholder)}</option>`;
    if (star) html += `<option value="*"${selected === '*' ? ' selected' : ''}>* (all columns)</option>`;
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
    const aggs = Sql.AGGREGATES;

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

    const selectCard = `<div class="card">
      <div class="card-head">
        <h3>Columns <span class="muted">(SELECT)</span></h3>
        <div class="opts">
          <label><input type="checkbox" data-path="distinct"${q.distinct ? ' checked' : ''}> DISTINCT</label>
          <label>TOP <input type="number" min="0" placeholder="all" data-path="top" value="${esc(q.top)}"></label>
        </div>
      </div>
      ${q.select.length ? '' : '<p class="placeholder">No columns chosen — all columns (*) will be returned. Click columns in the schema panel or add them here.</p>'}
      ${q.select.map((s, i) => `<div class="row">
        <select data-path="select.${i}.agg" title="Aggregate">${options(aggs, s.agg)}</select>
        <select class="col" data-path="select.${i}.col">${columnOptions(s.col, { star: true })}</select>
        <span class="muted">AS</span><input class="as" placeholder="alias (optional)" data-path="select.${i}.as" value="${esc(s.as)}">
        <button class="icon" data-action="move" data-list="select" data-index="${i}" data-dir="-1" title="Move up">↑</button>
        <button class="icon" data-action="move" data-list="select" data-index="${i}" data-dir="1" title="Move down">↓</button>
        <button class="icon" data-action="remove" data-list="select" data-index="${i}" title="Remove">✕</button>
      </div>`).join('')}
      <div class="btn-row">
        <button class="link" data-action="add-select">+ column</button>
        <button class="link" data-action="add-count">+ COUNT(*)</button>
      </div>
      ${q.select.some(s => s.agg) ? '<p class="hint">Non-aggregated columns are added to GROUP BY automatically.</p>' : ''}
    </div>`;

    const filterCard = `<div class="card">
      <div class="card-head"><h3>Filters <span class="muted">(WHERE / HAVING)</span></h3></div>
      ${q.where.length ? '' : '<p class="placeholder">No filters. Filters with an aggregate (e.g. COUNT &gt; 5) become HAVING.</p>'}
      ${q.where.map((w, i) => {
        const noValue = Sql.NO_VALUE_OPS.has(w.op);
        const custom = w.op === 'custom';
        const placeholder = custom ? "raw SQL, e.g. (a.X = 1 OR a.Y = 2)"
          : (w.op === 'IN' || w.op === 'NOT IN') ? 'a, b, c' : 'value or @param';
        return `<div class="row">
          ${i ? `<select data-path="where.${i}.conj">${options([['AND', 'AND'], ['OR', 'OR']], w.conj)}</select>` : '<span class="kw">WHERE</span>'}
          ${custom ? '' : `<select data-path="where.${i}.agg" title="Aggregate (makes this a HAVING filter)">${options(aggs, w.agg)}</select>
          <select class="col" data-path="where.${i}.col">${columnOptions(w.col)}</select>`}
          <select data-path="where.${i}.op">${options(Sql.OPERATORS.map(o => [o, o]), w.op)}</select>
          ${noValue ? '' : `<input class="value" placeholder="${esc(placeholder)}" data-path="where.${i}.value" value="${esc(w.value)}"${custom ? ' style="width:280px"' : ''}>`}
          ${w.op === 'BETWEEN' ? `<span class="muted">and</span><input class="value" data-path="where.${i}.value2" value="${esc(w.value2)}">` : ''}
          <button class="icon" data-action="remove" data-list="where" data-index="${i}" title="Remove">✕</button>
        </div>`;
      }).join('')}
      <button class="link" data-action="add-where">+ filter</button>
    </div>`;

    const orderCard = `<div class="card">
      <div class="card-head"><h3>Sort <span class="muted">(ORDER BY)</span></h3></div>
      ${q.orderBy.map((o, i) => `<div class="row">
        <select data-path="orderBy.${i}.agg" title="Aggregate">${options(aggs, o.agg)}</select>
        <select class="col" data-path="orderBy.${i}.col">${columnOptions(o.col)}</select>
        <select data-path="orderBy.${i}.dir">${options([['ASC', 'Ascending'], ['DESC', 'Descending']], o.dir)}</select>
        <button class="icon" data-action="move" data-list="orderBy" data-index="${i}" data-dir="-1" title="Move up">↑</button>
        <button class="icon" data-action="remove" data-list="orderBy" data-index="${i}" title="Remove">✕</button>
      </div>`).join('')}
      <button class="link" data-action="add-order">+ sort</button>
    </div>`;

    $('#builder').innerHTML = tablesCard + selectCard + filterCard + orderCard;
  }

  function highlight(sql) {
    const re = /(--[^\n]*)|('(?:[^']|'')*')|(\[(?:[^\]]|\]\])*\])|(\b\d+(?:\.\d+)?\b)|(\b(?:SELECT|DISTINCT|TOP|FROM|AS|INNER|LEFT|RIGHT|FULL|OUTER|CROSS|JOIN|ON|AND|OR|NOT|WHERE|GROUP|BY|HAVING|ORDER|ASC|DESC|IN|LIKE|BETWEEN|IS|NULL|COUNT|SUM|AVG|MIN|MAX)\b)/g;
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

  function setPath(obj, path, value) {
    const parts = path.split('.');
    const last = parts.pop();
    parts.forEach(p => { obj = obj[p]; });
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
    'add-select': () => { state.query.select.push({ col: '', agg: '', as: '' }); renderAll(); },
    'add-count': () => { state.query.select.push({ col: '*', agg: 'COUNT', as: 'RowCount' }); renderAll(); },
    'add-where': () => { state.query.where.push({ conj: 'AND', agg: '', col: '', op: '=', value: '', value2: '' }); renderAll(); },
    'add-order': () => { state.query.orderBy.push({ col: '', agg: '', dir: 'ASC' }); renderAll(); },
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
      setPath(state.query, el.dataset.path, el.type === 'checkbox' ? el.checked : el.value);
      if (el.tagName === 'SELECT' || el.type === 'checkbox') renderAll();
      else renderSql();
    }
  });

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
