interface WordSegmenter {
  segment(value: string): Iterable<{ index: number; isWordLike?: boolean }>;
}

export function createWordCounter(segmenter: WordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" })) {
  let lines: string[] | null = null;
  let counts: number[] = [];
  let total = 0;
  const countLine = (line: string) => {
    let count = 0;
    for (const word of segmenter.segment(line)) if (word.isWordLike) count++;
    return count;
  };
  return {
    count(source: string) {
      source = String(source);
      const nextLines = source.split("\n");
      if (lines === null) {
        counts = new Array<number>(nextLines.length).fill(0);
        let line = 0;
        let lineEnd = nextLines[0]?.length ?? 0;
        for (const word of segmenter.segment(source)) {
          if (!word.isWordLike) continue;
          while (word.index > lineEnd && line + 1 < nextLines.length) {
            line++;
            lineEnd += nextLines[line].length + 1;
          }
          counts[line]++;
          total++;
        }
        lines = nextLines;
        return total;
      }
      const nextCounts = new Array<number>(nextLines.length);
      let prefix = 0;
      while (prefix < lines.length && prefix < nextLines.length && lines[prefix] === nextLines[prefix]) {
        nextCounts[prefix] = counts[prefix];
        prefix++;
      }
      let oldEnd = lines.length;
      let nextEnd = nextLines.length;
      while (oldEnd > prefix && nextEnd > prefix && lines[oldEnd - 1] === nextLines[nextEnd - 1]) {
        oldEnd--;
        nextEnd--;
      }
      for (let index = prefix; index < oldEnd; index++) total -= counts[index];
      for (let index = prefix; index < nextEnd; index++) {
        nextCounts[index] = countLine(nextLines[index]);
        total += nextCounts[index];
      }
      for (let offset = 0; oldEnd + offset < lines.length; offset++)
        nextCounts[nextEnd + offset] = counts[oldEnd + offset];
      lines = nextLines;
      counts = nextCounts;
      return total;
    },
  };
}
