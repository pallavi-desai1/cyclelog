// The only entry point. Everything else is imported from here, which is what
// lets one <script type="module"> and one CSP directive cover the whole app.
if ('serviceWorker' in navigator) {
  // Registration failure is not fatal: without the worker the app still runs,
  // it just will not open offline.
  navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
}
