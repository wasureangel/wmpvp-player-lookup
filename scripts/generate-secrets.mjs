import {randomBytes} from 'node:crypto';
// Run privately on your own computer. Do not commit or share the generated values.
console.log('SESSION_SECRET='+randomBytes(32).toString('hex'));
console.log('SITE_PASSWORD='+randomBytes(18).toString('base64url'));
