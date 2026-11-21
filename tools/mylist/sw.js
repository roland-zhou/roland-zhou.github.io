self.addEventListener('push', (event) => {
    const { title, body, tag } = event.data.json();
    event.waitUntil(self.registration.showNotification(title, { body, tag }));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil((async () => {
        const scope = self.registration.scope;
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const app = windows.find((client) => client.url.startsWith(scope));
        if (app) await app.focus();
        else await self.clients.openWindow(scope);
    })());
});
