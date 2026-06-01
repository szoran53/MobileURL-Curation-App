function extractURLsFromEmail(text) {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
  const matches = text.match(urlRegex) || [];
  const cleaned = [...new Set(matches.map(u => u.replace(/[.,;!?)]+$/, '').trim()))];
  return cleaned.filter(u => {
    const lower = u.toLowerCase();
    return !lower.includes('unsubscribe') &&
           !lower.includes('click.') &&
           !lower.includes('track.') &&
           !lower.includes('pixel') &&
           u.length > 10;
  });
}

module.exports = { extractURLsFromEmail };
