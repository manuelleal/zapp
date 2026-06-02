/**
 * api/src/lib/hrefUtils.js — Utilidades de URL compartidas
 */

function actIdFromHref(href) {
  if (!href) return null;
  const m = href.match(/[?&]id=(\d+)/);
  return m ? m[1] : null;
}

module.exports = { actIdFromHref };
