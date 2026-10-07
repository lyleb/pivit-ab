// Error bodies returned to the login page and the client portal. The real
// exception is logged for the operator and is never copied into the JSON.

const PUBLIC_ERROR = 'Something went wrong. Please try again.';

function publicServerError(err) {
  console.error(err);
  return { error: PUBLIC_ERROR };
}

module.exports = { PUBLIC_ERROR, publicServerError };
