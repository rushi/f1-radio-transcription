import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHighlighter, escapeHtml, getNameWords, highlightTerms, hexToOklch, teamBarColor, relativeTime, isOld } from '../web/format.mjs';

test('escapeHtml escapes markup characters', () => {
    assert.equal(escapeHtml(`<img src=x onerror="a">&'`), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
    assert.equal(escapeHtml(null), '');
});

test('highlightTerms bolds key terms and colors flag terms', () => {
    assert.equal(highlightTerms('Box box, safety car'), '<b class="t-pit">Box box</b>, <b class="t-flag-y">safety car</b>');
    assert.equal(highlightTerms('Red flag, red flag'), '<b class="t-flag-r">Red flag</b>, <b class="t-flag-r">red flag</b>');
    assert.equal(highlightTerms('Virtual safety car deployed'), '<b class="t-flag-y">Virtual safety car</b> deployed');
    assert.equal(highlightTerms('VSC ending'), '<b class="t-flag-y">VSC</b> ending');
});

test('highlightTerms matches whole words only', () => {
    assert.equal(highlightTerms('boxes inbox'), 'boxes inbox');
    assert.equal(highlightTerms('rainy'), 'rainy');
});

test('highlightTerms escapes transcript text before adding markup', () => {
    assert.equal(highlightTerms('<script>box</script>'), '&lt;script&gt;<b>box</b>&lt;/script&gt;');
});

test('hexToOklch converts known colors', () => {
    assert.ok(Math.abs(hexToOklch('#FFFFFF').l - 1) < 0.001);
    assert.ok(hexToOklch('#000000').l < 0.001);
    assert.ok(Math.abs(hexToOklch('F47600').l - 0.70) < 0.05);
    assert.equal(hexToOklch('nope'), null);
});

test('teamBarColor lifts dark colors on dark and caps light colors on light', () => {
    const lightness = (css) => Number(css.match(/^oklch\(([\d.]+)/)[1]);
    assert.equal(lightness(teamBarColor('1868DB', 'dark')), 0.62);
    assert.ok(lightness(teamBarColor('F47600', 'dark')) > 0.62);
    assert.equal(lightness(teamBarColor('9C9FA2', 'light')), 0.58);
    assert.equal(teamBarColor(null, 'dark'), 'var(--text-2)');
});

test('relativeTime uses short labels', () => {
    const now = Date.parse('2026-10-11T12:10:00Z');
    assert.equal(relativeTime('2026-10-11T12:09:55Z', now), 'now');
    assert.equal(relativeTime('2026-10-11T12:09:15Z', now), '45s');
    assert.equal(relativeTime('2026-10-11T12:08:00Z', now), '2m');
    assert.equal(relativeTime('2026-10-11T11:00:00Z', now), '1h');
    assert.equal(relativeTime('2026-10-11T12:11:00Z', now), 'now');
});

test('isOld is true after 5 minutes', () => {
    const now = Date.parse('2026-10-11T12:10:00Z');
    assert.equal(isOld('2026-10-11T12:05:01Z', now), false);
    assert.equal(isOld('2026-10-11T12:04:59Z', now), true);
});

test('getNameWords splits first and family names', () => {
    assert.deepEqual(getNameWords('Lando NORRIS'), ['Lando', 'Norris']);
    assert.deepEqual(getNameWords('Nyck DE VRIES'), ['Nyck', 'De Vries']);
    assert.deepEqual(getNameWords(null), []);
});

test('createHighlighter colors other drivers by name and leaves the speaker plain', () => {
    const highlight = createHighlighter([
        { word: 'Max', driverNumber: 3, color: 'oklch(0.62 0.1 258)' },
        { word: 'Verstappen', driverNumber: 3, color: 'oklch(0.62 0.1 258)' },
        { word: 'Lando', driverNumber: 1, color: 'oklch(0.7 0.18 51)' },
    ]);
    assert.equal(highlight('Verstappen behind, box', { speakerNumber: 1 }), '<b class="t-name" style="--name:oklch(0.62 0.1 258)">Verstappen</b> behind, <b>box</b>');
    assert.equal(highlight('Good job Lando', { speakerNumber: 1 }), 'Good job Lando');
    assert.equal(highlight('max power', { speakerNumber: 1 }), 'max power');
    assert.equal(highlight('<Max>', { speakerNumber: 1 }), '&lt;<b class="t-name" style="--name:oklch(0.62 0.1 258)">Max</b>&gt;');
});

test('highlightTerms marks repeated box as a pit call and leaves a single box bold', () => {
    assert.equal(highlightTerms('Box box, stay out'), '<b class="t-pit">Box box</b>, stay out');
    assert.equal(highlightTerms('Okay, box, box, box.'), 'Okay, <b class="t-pit">box, box, box</b>.');
    assert.equal(highlightTerms('Box this lap'), '<b>Box</b> this lap');
    assert.equal(highlightTerms('box-box now'), '<b class="t-pit">box-box</b> now');
});
