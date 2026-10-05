  // Old shared links pointed at the field map on this address (/#room=...): send them on to it.
  if (/^#room=/.test(location.hash)) location.replace('/map' + location.hash);
