function timestamp() {
  return new Date().toISOString();
}

function createLogger(scope = "app") {
  function write(level, message, fields = {}) {
    const safeFields = { ...fields };
    for (const key of Object.keys(safeFields)) {
      if (/password|keyword|licen[cs]e|credential|token|secret/i.test(key)) {
        safeFields[key] = "[redacted]";
      }
    }

    console.log(JSON.stringify({
      time: timestamp(),
      level,
      scope,
      message,
      ...safeFields,
    }));
  }

  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}

function publicError(error) {
  if (!error) {
    return "Unknown error";
  }

  return String(error.message || error).replace(/\s+/g, " ").slice(0, 300);
}

module.exports = {
  createLogger,
  publicError,
};
