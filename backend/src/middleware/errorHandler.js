export const notFoundHandler = (req, res) => {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.originalUrl}`
  });
};

export const errorHandler = (error, _req, res, _next) => {
  if (res.headersSent) {
    res.destroy(error);
    return;
  }

  const status = error.status || 500;
  const payload = {
    error: error.message || 'Something went wrong.'
  };

  if (error.details) {
    payload.details = error.details;
  }

  if (status >= 500) {
    console.error(error);
  }

  res.status(status).json(payload);
};
