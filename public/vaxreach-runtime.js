(() => {
  'use strict';

  let csrfToken = '';
  let databasePromise;

  async function apiRequest(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken) headers.set('X-CSRF-Token', csrfToken);
    const response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    if (data?.csrfToken) csrfToken = data.csrfToken;
    return data;
  }

  function openLocalDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('Offline draft storage is unavailable in this browser.'));
      const request = indexedDB.open('vaxreach-offline', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('draftOutbox')) db.createObjectStore('draftOutbox', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open offline draft storage.'));
      request.onblocked = () => reject(new Error('Close other VaxReach tabs to update offline storage.'));
    });
    return databasePromise;
  }

  async function outboxTransaction(mode, action) {
    const db = await openLocalDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('draftOutbox', mode);
      const store = transaction.objectStore('draftOutbox');
      let value;
      try { value = action(store); } catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(value?.result);
      transaction.onerror = () => reject(transaction.error || new Error('Could not save the offline draft.'));
      transaction.onabort = () => reject(transaction.error || new Error('Offline draft save was cancelled.'));
    });
  }

  const Outbox = {
    put(draft) { return outboxTransaction('readwrite', store => store.put(draft)); },
    remove(id) { return outboxTransaction('readwrite', store => store.delete(id)); },
    all() { return outboxTransaction('readonly', store => store.getAll()); }
  };

  window.VaxReachRuntime = Object.freeze({
    apiRequest,
    setCsrfToken(token) { csrfToken = token || ''; },
    Outbox
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }, { once: true });
  }
})();
