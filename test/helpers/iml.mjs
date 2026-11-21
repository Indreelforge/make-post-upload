// A deliberately small IML evaluator for smoke tests. It covers only the expressions this app
// uses (paths, literals, the operators below and a handful of built-in functions) and throws on
// anything else. Make's real IML engine is not public, so passing here shows the templates are
// well-formed and produce the intended request shape; it does not prove Make's exact semantics.

const FUNCTIONS = {
  if: (c, a, b) => (c ? a : b),
  ifempty: (a, b) => (a === undefined || a === null || a === '' ? b : a),
  toCollection: (arr, k, v) => Object.fromEntries((Array.isArray(arr) ? arr : []).filter((e) => e && e[k] !== undefined && e[k] !== '').map((e) => [e[k], e[v]])),
  omit: (obj, ...keys) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => !keys.includes(k))),
  length: (x) => (x === undefined || x === null ? 0 : x.length ?? Object.keys(x).length),
  substring: (s, start, end) => String(s ?? '').substring(start, end),
  switch: (value, ...rest) => {
    for (let i = 0; i + 1 < rest.length; i += 2) if (rest[i] === value) return rest[i + 1];
    return rest.length % 2 ? rest[rest.length - 1] : undefined;
  },
  join: (arr, sep) => (Array.isArray(arr) ? arr.join(sep) : ''),
  contains: (arr, v) => (Array.isArray(arr) ? arr.includes(v) : String(arr ?? '').includes(v)),
  encodeURL: (s) => encodeURIComponent(String(s ?? '')),
  // UTC only; tokens YYYY MM DD HH mm ss SSS Z.
  formatDate: (d, fmt) => {
    if (d === undefined || d === null || d === '') return '';
    const date = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(date.getTime())) throw new Error(`formatDate: invalid date ${d}`);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    const map = { YYYY: date.getUTCFullYear(), MM: p(date.getUTCMonth() + 1), DD: p(date.getUTCDate()), HH: p(date.getUTCHours()), mm: p(date.getUTCMinutes()), ss: p(date.getUTCSeconds()), SSS: p(date.getUTCMilliseconds(), 3), Z: '+00:00' };
    return fmt.replace(/YYYY|SSS|MM|DD|HH|mm|ss|Z/g, (t) => map[t]);
  },
};

const KEYWORDS = { true: true, false: false, null: null, undefined };

function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(===|!==|==|!=|<=|>=|&&|\|\||[-+*/%<>!=().,[\]])|([A-Za-z_$][\w$]*)|(`[^`]*`))/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(re.lastIndex))) break;
    m = re.exec(src);
    if (!m) throw new Error(`IML: cannot parse "${src}" at ${re.lastIndex}`);
    if (m[1]) tokens.push({ t: 'num', v: Number(m[1]) });
    else if (m[2]) tokens.push({ t: 'str', v: m[2].slice(1, -1).replace(/\\(.)/g, '$1') });
    else if (m[3]) tokens.push({ t: 'op', v: m[3] });
    else if (m[4]) tokens.push({ t: 'id', v: m[4] });
    else if (m[5]) tokens.push({ t: 'id', v: m[5].slice(1, -1) });
  }
  return tokens;
}

export function evaluate(src, ctx) {
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const eat = (v) => { if (peek()?.v !== v) throw new Error(`IML: expected "${v}" in "${src}"`); i += 1; };
  const isOp = (...ops) => peek()?.t === 'op' && ops.includes(peek().v);

  const binary = (next, ops, apply) => () => {
    let left = next();
    while (isOp(...ops)) { const op = tokens[i++].v; left = apply(op, left, next()); }
    return left;
  };
  const primary = () => {
    const tok = tokens[i++];
    if (!tok) throw new Error(`IML: unexpected end of "${src}"`);
    if (tok.t === 'num' || tok.t === 'str') return { value: tok.v };
    if (tok.t === 'op' && tok.v === '(') { const v = expr(); eat(')'); return { value: v }; }
    if (tok.t === 'id') {
      if (isOp('(')) {
        const fn = FUNCTIONS[tok.v];
        if (!fn) throw new Error(`IML: function ${tok.v}() is not supported by the test evaluator`);
        eat('(');
        const args = [];
        while (!isOp(')')) { args.push(expr()); if (isOp(',')) eat(','); }
        eat(')');
        return { value: fn(...args) };
      }
      if (tok.v in KEYWORDS) return { value: KEYWORDS[tok.v] };
      if (!(tok.v in ctx)) throw new Error(`IML: unknown variable ${tok.v} in "${src}"`);
      return { value: ctx[tok.v] };
    }
    throw new Error(`IML: unexpected token ${tok.v} in "${src}"`);
  };
  const postfix = () => {
    let { value } = primary();
    for (;;) {
      if (isOp('.')) { eat('.'); const name = tokens[i++].v; value = value?.[name]; } else if (isOp('[')) { eat('['); const k = expr(); eat(']'); value = Array.isArray(value) && typeof k === 'number' ? value[k < 0 ? value.length + k : k - 1] : value?.[k]; } else break;
    }
    return value;
  };
  const unary = () => {
    if (isOp('!')) { eat('!'); return !unary(); }
    if (isOp('-')) { eat('-'); return -unary(); }
    return postfix();
  };
  const mul = binary(unary, ['*', '/', '%'], (op, a, b) => (op === '*' ? a * b : op === '/' ? a / b : a % b));
  const add = binary(mul, ['+', '-'], (op, a, b) => (op === '+' ? (typeof a === 'string' || typeof b === 'string' ? `${a ?? ''}${b ?? ''}` : a + b) : a - b));
  const rel = binary(add, ['<', '<=', '>', '>='], (op, a, b) => ({ '<': a < b, '<=': a <= b, '>': a > b, '>=': a >= b })[op]);
  const eq = binary(rel, ['==', '===', '=', '!=', '!=='], (op, a, b) => (op.startsWith('!') ? a !== b : a === b));
  const and = binary(eq, ['&&'], (op, a, b) => a && b);
  const or = binary(and, ['||'], (op, a, b) => a || b);
  function expr() { return or(); }

  const value = expr();
  if (i !== tokens.length) throw new Error(`IML: trailing tokens in "${src}"`);
  return value;
}

/** Renders an IML template value. Keys whose value is undefined are dropped; "{{...}}" spreads. */
export function render(template, ctx) {
  if (typeof template === 'string') {
    const whole = /^\{\{([\s\S]*)\}\}$/.exec(template);
    if (whole && !whole[1].includes('}}')) return evaluate(whole[1], ctx);
    return template.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => { const v = evaluate(e, ctx); return v === undefined || v === null ? '' : String(v); });
  }
  if (Array.isArray(template)) return template.map((v) => render(v, ctx));
  if (template && typeof template === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(template)) {
      if (key === '{{...}}') { Object.assign(out, render(value, ctx)); continue; }
      const rendered = render(value, ctx);
      if (rendered !== undefined) out[render(key, ctx)] = rendered;
    }
    return out;
  }
  return template;
}

/** Make's processing of empty inputs (Apps platform v2): blank values are not passed at all. */
export function mappedParameters(values) {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)));
}
