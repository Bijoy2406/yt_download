export const sanitizeFilename = (value) =>
  `${value || 'download'}`
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'download';

