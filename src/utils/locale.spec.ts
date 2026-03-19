import Locale from './locale';

describe('Locale', () => {
  describe('parse', () => {
    let locale;

    beforeEach(() => {
      locale = new Locale('fr');
    });

    it('should parse date matching the given format', () => {
      const result = locale.parse('24/12/2024 10:00', 'DD/MM/YYYY HH:mm');

      expect(result).toStrictEqual(new Date(2024, 11, 24, 10, 0));
    });

    it('should fail to parse date not matching the format', () => {
      const result = locale.parse('24/12/2024', 'DD/MM/YYYY HH:mm');

      expect(result).toBe(undefined);
    });

    it('should fail to parse date not matching the format but in a format supported by native Date.parse', () => {
      const result = locale.parse('12/24/2024', 'DD/MM/YYYY HH:mm');

      expect(result).toBe(undefined);
    });
  });
});
