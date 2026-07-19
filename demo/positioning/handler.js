'use strict';

const { positionFromIngest } = require('./from-ingest');

function createPositioningHandler(options, onPosition = () => {}) {
  if (typeof onPosition !== 'function') throw new TypeError('onPosition must be a function');

  return function handlePositioning(payload) {
    const position = positionFromIngest(payload, options);
    if (position) onPosition(position);
    return position;
  };
}

module.exports = { createPositioningHandler };
