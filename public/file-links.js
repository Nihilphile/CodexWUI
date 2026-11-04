(() => {
  window.CodexFileLinks = {
    content(project, path, browser = false) {
      const query = new URLSearchParams({ project, path });
      if (browser) query.set('browser', '1');
      return `/api/files/content?${query}`;
    },
    browser(href) {
      const url = new URL(href, window.location.href);
      // A real link click supplies the user gesture required by Android intents.
      // Already in Edge (or on desktop), use its normal native PDF navigation.
      if (!/Android/i.test(navigator.userAgent) || /EdgA\//i.test(navigator.userAgent)) return url.href;
      return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=${url.protocol.slice(0, -1)};package=com.microsoft.emmx;S.browser_fallback_url=${encodeURIComponent(url.href)};end`;
    },
  };
})();
