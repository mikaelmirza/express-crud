// Entry point. The app is loaded with a dynamic import so that a configuration
// mistake or a busy port prints a short explanation instead of a stack trace.
// Everything else lives in main.js.
try {
  const { start } = await import('./main.js');
  await start();
} catch (err) {
  if (/^Invalid (auth )?configuration:/.test(err.message)) {
    console.error(err.message);
  } else if (err.code === 'EADDRINUSE') {
    console.error(`Port ${err.port} is already in use. Stop whatever is using it, or set PORT to another port.`);
  } else {
    console.error(err);
  }
  process.exit(1);
}
