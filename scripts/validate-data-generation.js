#!/usr/bin/env node
'use strict';

const path = require('path');
const { validateCurrentGeneration } = require('../src/lib/publish_data');

validateCurrentGeneration(path.join(__dirname, '..', 'data'))
  .then((result) => {
    console.log('data generation valid', JSON.stringify(result));
    if (result.legacy) {
      console.warn('legacy generation pointer: structural checks passed; checksums are unavailable');
    }
  })
  .catch((error) => {
    console.error('data generation invalid:', error.message || error);
    process.exitCode = 1;
  });
