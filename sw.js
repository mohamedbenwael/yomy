/* sw.js — Service Worker لتطبيق «يومي»
   مسؤول عن إظهار الإشعارات وفتح التطبيق عند الضغط عليها.
   مقصود إنه بسيط: مفيش تخزين/كاش علشان مايحصلش إن النسخة القديمة تفضل ظاهرة. */

self.addEventListener('install', event => {
  self.skipWaiting();           // فعّل النسخة الجديدة فورًا
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());  // امسك الصفحات المفتوحة على طول
});

// لو وصلت رسالة من الصفحة (احتياطي)
self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'notify') {
    self.registration.showNotification('يومي 🌿', {
      body: data.body || '',
      icon: data.icon || '',
      badge: data.icon || '',
      tag: data.tag || 'yomy',
      renotify: true,
      dir: 'rtl',
      lang: 'ar'
    });
  }
});

// عند الضغط على الإشعار: افتح التطبيق أو رجّعه للواجهة
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('./');
    })
  );
});
