#!/usr/bin/env node
import '../src/register.js';

// React's development build is several times slower and only adds warnings. React picks its build
// when first imported, so NODE_ENV is set for these imports only and then put back: whatever
// Hail starts shouldn't inherit it.
const nodeEnv = process.env.NODE_ENV;
if (nodeEnv === undefined) process.env.NODE_ENV = 'production';
await import('react');
await import('react/jsx-runtime');
await import('ink');
if (nodeEnv === undefined) delete process.env.NODE_ENV;

await import('../src/cli.jsx');
