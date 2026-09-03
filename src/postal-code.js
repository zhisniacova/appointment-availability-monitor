const CANADIAN_POSTAL_CODE_PATTERN = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d$/i;

function normalizePostalCode(input) {
  const compact = String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length !== 6 || !CANADIAN_POSTAL_CODE_PATTERN.test(compact)) {
    return null;
  }

  return `${compact.slice(0, 3)} ${compact.slice(3)}`;
}

module.exports = {
  CANADIAN_POSTAL_CODE_PATTERN,
  normalizePostalCode,
};
