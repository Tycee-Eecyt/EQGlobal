const el = require("electron");
console.log('typeof module', typeof el);
console.log('keys', Object.keys(el));
console.log('has app', !!el.app);
console.log('has BrowserWindow', !!el.BrowserWindow);
console.log('default keys', el.default ? Object.keys(el.default) : []);