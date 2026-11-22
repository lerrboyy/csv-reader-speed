// solve.js — a faster drop-in for csv-reader 1.0.0 (make.fun bounty csv-reader-speed-01-run-20261121).
//
// Reads broken CSV exactly as csv-reader does: a U+FEFF at the very start is dropped, a record
// ends at LF or CRLF, a line left with no characters is no record, a CR outside quotes that is
// not followed by LF is dropped with a stray_cr error, a field opening with a quote runs to the
// next quote that is not doubled ("" is one quote, CRLF or a lone CR inside reads as LF), junk
// after a closing quote is appended with a quote_junk error, a quote that never closes is a
// literal character and the rest of the field is re-read as unquoted (unterminated_quote), a
// quote inside an unquoted field is literal, and later records are padded (short_row) or cut
// (long_row) to the first record's width. Errors carry {code, line, row} in the order met.
//
// Written fresh from the bounty design spec. No dependency, no regex, one left-to-right pass.
//
// Speed: most records are one physical line, so each is taken as a single slice and split on
// commas by native code. A line with no quotes and no CRs is done there. A line with quotes
// is split the same way and its pieces are walked: a piece that does not open with a quote
// is a whole field, and a quoted field is reassembled from the pieces it spans (joining
// them with commas) until its closing quote is found. Only a quoted field that runs past
// the line's end (a multi-line note), a stray CR, or an unterminated quote falls back to
// the field-by-field scan, which still jumps with native indexOf searches: an unquoted
// field ends at the next comma or line break, a plain quoted field is one slice, and only
// doubled quotes or line breaks inside quotes take the slow character walk.

export function run(input) {
  const text = input.text;
  const header = input.header;
  const n = text.length;
  const rows = [];
  const errors = [];
  let columns = null;
  let width = 0; // 0 = first record not seen yet
  let headerDone = !header;
  let line = 1;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  // Scratch for the quote_junk errors a line-level parse meets: they are only kept when
  // the line parses whole, so a line that bails to the slow path leaves none behind.
  const pend = [];

  // Row for an error met now: null while the header record is being read (or before any
  // record, with header true), else the index of the record in progress, or of the next
  // record when none is in progress (both are the number of data rows already completed).
  const rowNow = () => (headerDone ? rows.length : null);

  function finishRecord(fields, recLine) {
    if (width === 0) {
      width = fields.length;
      if (header) {
        columns = fields;
        headerDone = true;
      } else {
        rows.push(fields);
      }
    } else if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: rows.length, fields: fields.length });
      while (fields.length < width) fields.push('');
      rows.push(fields);
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: rows.length, extra: fields.slice(width) });
      fields.length = width;
      rows.push(fields);
    } else {
      rows.push(fields);
    }
  }

  // Try to parse one physical line (which holds no CR) as a single record. The line is
  // split on commas; pieces are walked left to right and written back into the same
  // array as fields (a field never starts before the piece it is read from, so no piece
  // is overwritten before it is read). A quoted field is reassembled from the pieces it
  // spans, joining them with commas, until its closing quote is found; junk after the
  // closing quote is appended and a quote_junk error collected in pend. Returns the
  // fields, or null when a quoted field runs past the line's end (a multi-line field,
  // or a quote that never closes) and the caller must fall back to the slow parse.
  function tryParseLine(lineStr, recLine) {
    const pieces = lineStr.split(',');
    let f = 0;
    let p = 0;
    while (p < pieces.length) {
      const piece = pieces[p];
      if (piece.charCodeAt(0) !== 34) {
        pieces[f++] = piece; // unquoted field (a quote inside it is literal)
        p++;
        continue;
      }
      // Quoted field opening at piece p. Find its closing quote: the first quote not
      // followed by another quote. A quote at a piece's end is never doubled, because
      // the character after it in the text is the comma the split removed.
      let content = null;
      let pieceIdx = p;
      let searchFrom = 1;
      let segStart = 1;
      let closePiece = -1;
      let closeQ = -1;
      for (;;) {
        const cur = pieces[pieceIdx];
        let q = cur.indexOf('"', searchFrom);
        while (q !== -1 && cur.charCodeAt(q + 1) === 34) q = cur.indexOf('"', q + 2);
        if (q !== -1) {
          closePiece = pieceIdx;
          closeQ = q;
          break;
        }
        // No closing quote in this piece: the field runs on past a comma.
        const part = cur.slice(segStart);
        content = content === null ? part : content + ',' + part;
        pieceIdx++;
        if (pieceIdx >= pieces.length) return null;
        searchFrom = 0;
        segStart = 0;
      }
      const cur = pieces[closePiece];
      const lastSeg = cur.slice(segStart, closeQ);
      content = content === null ? lastSeg : content + ',' + lastSeg;
      if (content.indexOf('"') !== -1) content = content.replaceAll('""', '"');
      const junk = cur.slice(closeQ + 1);
      let field = content;
      if (junk.length > 0) {
        field = content + junk;
        pend.push({ code: 'quote_junk', line: recLine, row: rowNow() });
      }
      pieces[f++] = field;
      p = closePiece + 1;
    }
    pieces.length = f;
    return pieces;
  }

  // Scan one unquoted field starting at p. Returns [value, nextPos, kind] where kind is
  // 'comma' (another field follows), 'eol' (the record ends at a line break) or 'eof'.
  // A CR inside the field that is not part of a CRLF line break is a stray CR: it is
  // dropped, one stray_cr error each, and the field goes on. Every CR left inside the
  // sliced field is a stray one, because a CR followed by LF would have made that LF the
  // first line break found, and a CR before a comma would have done the same.
  function scanUnquoted(p, recLine) {
    const c = text.indexOf(',', p);
    const nl = text.indexOf('\n', p);
    let m;
    let kind;
    if (c === -1) {
      m = nl;
      kind = 'eol';
    } else if (nl === -1) {
      m = c;
      kind = 'comma';
    } else if (c < nl) {
      m = c;
      kind = 'comma';
    } else {
      m = nl;
      kind = 'eol';
    }
    let end;
    if (m === -1) {
      end = n;
      kind = 'eof';
    } else if (kind === 'eol' && m > p && text.charCodeAt(m - 1) === 13) {
      end = m - 1; // CRLF: the CR belongs to the line break, not the field
    } else {
      end = m;
    }
    let field = text.slice(p, end);
    let r = field.indexOf('\r');
    if (r !== -1) {
      do {
        errors.push({ code: 'stray_cr', line: recLine, row: rowNow() });
        r = field.indexOf('\r', r + 1);
      } while (r !== -1);
      field = field.replaceAll('\r', '');
    }
    return [field, kind === 'eof' ? n : m + 1, kind];
  }

  // Scan the junk after a quoted field whose closing quote is at q, from q + 1 on.
  // Returns [field, nextPos, kind] as in scanUnquoted. Junk is appended as it stands;
  // a lone CR in it is dropped with a stray_cr error and the junk scan goes on, a CRLF
  // ends the record, a comma ends the field. A quote_junk error is recorded when the
  // field ends, but only if any junk (other than dropped CRs) was appended.
  function scanJunk(content, q, recLine) {
    const j = q + 1;
    const c = text.indexOf(',', j);
    const nl = text.indexOf('\n', j);
    let m;
    let kind;
    if (c === -1) {
      m = nl;
      kind = 'eol';
    } else if (nl === -1) {
      m = c;
      kind = 'comma';
    } else if (c < nl) {
      m = c;
      kind = 'comma';
    } else {
      m = nl;
      kind = 'eol';
    }
    let end;
    if (m === -1) {
      end = n;
      kind = 'eof';
    } else if (kind === 'eol' && m > j && text.charCodeAt(m - 1) === 13) {
      end = m - 1; // CRLF ends the record; the CR is not junk
    } else {
      end = m;
    }
    let junk = text.slice(j, end);
    let r = junk.indexOf('\r');
    if (r !== -1) {
      do {
        errors.push({ code: 'stray_cr', line: recLine, row: rowNow() });
        r = junk.indexOf('\r', r + 1);
      } while (r !== -1);
      junk = junk.replaceAll('\r', '');
    }
    let field = content;
    if (junk.length > 0) {
      field = content + junk;
      errors.push({ code: 'quote_junk', line: recLine, row: rowNow() });
    }
    return [field, kind === 'eof' ? n : m + 1, kind];
  }

  // Parse a quoted field starting at p (text[p] is '"'). Returns [field, nextPos, kind]
  // as in scanUnquoted. The closing quote is the first quote not followed by another
  // quote, found with native jumps. A plain quoted field (no doubled quotes, no line
  // break inside) is a single slice; only doubled quotes or line breaks inside take
  // the character walk, which also counts the lines the field spans. A quote that
  // never closes is a literal character: the error is recorded first, then the rest
  // of the field is re-read as unquoted.
  function parseQuoted(p, recLine) {
    let q = text.indexOf('"', p + 1);
    while (q !== -1 && text.charCodeAt(q + 1) === 34) q = text.indexOf('"', q + 2);
    if (q === -1) {
      errors.push({ code: 'unterminated_quote', line: recLine, row: rowNow() });
      const [v, next, kind] = scanUnquoted(p + 1, recLine);
      return ['"' + v, next, kind];
    }
    const seg = text.slice(p + 1, q);
    if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) {
      const content = seg.indexOf('"') === -1 ? seg : seg.replaceAll('""', '"');
      return scanJunk(content, q, recLine);
    }
    // Doubled quotes and/or line breaks inside: walk once, joining segments.
    let parts = null;
    let segStart = p + 1;
    let j = p + 1;
    while (j < q) {
      const ch = text.charCodeAt(j);
      if (ch === 34) {
        // A doubled quote: q is the first quote not doubled, so this one is.
        if (parts === null) parts = [text.slice(segStart, j)];
        else parts.push(text.slice(segStart, j));
        parts.push('"');
        j += 2;
        segStart = j;
      } else if (ch === 10) {
        line++;
        if (parts === null) parts = [text.slice(segStart, j)];
        else parts.push(text.slice(segStart, j));
        parts.push('\n');
        j++;
        segStart = j;
      } else if (ch === 13) {
        line++;
        if (parts === null) parts = [text.slice(segStart, j)];
        else parts.push(text.slice(segStart, j));
        parts.push('\n');
        j += text.charCodeAt(j + 1) === 10 ? 2 : 1;
        segStart = j;
      } else {
        j++;
      }
    }
    const content = parts === null ? text.slice(segStart, q) : parts.join('') + text.slice(segStart, q);
    return scanJunk(content, q, recLine);
  }

  // Parse one record starting at p, field by field. Returns the position after the
  // record's line break, or n at the end of the text. Used for any record the line
  // paths cannot take (a stray CR in the line, or a quoted field running past it).
  function parseRecordSlow(p, recLine) {
    const fields = [];
    let pos = p;
    for (;;) {
      let field;
      let next;
      let kind;
      if (text.charCodeAt(pos) === 34) {
        [field, next, kind] = parseQuoted(pos, recLine);
      } else {
        [field, next, kind] = scanUnquoted(pos, recLine);
      }
      fields.push(field);
      if (kind === 'comma') {
        pos = next;
        continue;
      }
      if (kind === 'eol') line++;
      finishRecord(fields, recLine);
      return next;
    }
  }

  while (i < n) {
    const ch = text.charCodeAt(i);
    if (ch === 10) {
      i++; // blank LF line: no record, no error
      line++;
      continue;
    }
    if (ch === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        i += 2; // blank CRLF line: no record, no error
        line++;
        continue;
      }
      // A stray CR between records: dropped, one error, the record after it is next.
      errors.push({ code: 'stray_cr', line, row: rowNow() });
      i++;
      continue;
    }
    const recLine = line;
    // One physical line: the record is this line unless a quoted field runs past it.
    const nl = text.indexOf('\n', i);
    let e = nl === -1 ? n : nl;
    if (nl !== -1 && e > i && text.charCodeAt(e - 1) === 13) e--; // CRLF line break
    if (e === i) {
      // Empty line (defensive; blank lines are handled above).
      i = nl === -1 ? n : nl + 1;
      if (nl !== -1) line++;
      continue;
    }
    const lineStr = text.slice(i, e);
    if (lineStr.indexOf('\r') === -1) {
      if (lineStr.indexOf('"') === -1) {
        // Clean line: no quotes, no CRs; its fields are the line split on commas.
        finishRecord(lineStr.split(','), recLine);
        i = nl === -1 ? n : nl + 1;
        if (nl !== -1) line++;
        continue;
      }
      pend.length = 0;
      const fields = tryParseLine(lineStr, recLine);
      if (fields !== null) {
        for (let k = 0; k < pend.length; k++) errors.push(pend[k]);
        finishRecord(fields, recLine);
        i = nl === -1 ? n : nl + 1;
        if (nl !== -1) line++;
        continue;
      }
      // A quoted field runs past the line: fall through to the slow parse.
    }
    i = parseRecordSlow(i, recLine);
  }
  if (header && width === 0) columns = [];
  return { columns, rows, errors };
}
