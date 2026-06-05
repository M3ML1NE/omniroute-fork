const fs = require('fs');
const file = '/root/omniroute-fork/src/i18n/messages/ru.json';
let content = JSON.parse(fs.readFileSync(file, 'utf8'));

// The errors say:
// Could not resolve `settings.proxyGlobalConfigTab` in messages for locale `ru`.
// Could not resolve `settings.proxyPoolTab` in messages for locale `ru`.
// Could not resolve `settings.freePoolTab` in messages for locale `ru`.
// Could not resolve `settings.proxyDocumentationTab` in messages for locale `ru`.

content.settings = content.settings || {};
content.settings.proxyGlobalConfigTab = "Глобальные настройки прокси";
content.settings.proxyPoolTab = "Пул прокси";
content.settings.freePoolTab = "Бесплатный пул";
content.settings.proxyDocumentationTab = "Документация";

fs.writeFileSync(file, JSON.stringify(content, null, 2));
console.log('Added missing keys to ru.json');
