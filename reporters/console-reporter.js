const path = require('node:path');

class ConsoleReporter {
  onBegin(config, suite) {
    this.total = suite.allTests().length;
    this.results = new Map();
  }

  onTestEnd(test, result) {
    this.results.set(test.id, {
      file: path.relative(process.cwd(), test.location.file),
      line: test.location.line,
      title: test.title,
      status: result.status,
      duration: result.duration,
      error: result.error?.message,
    });
  }

  onEnd(result) {
    const tests = [...this.results.values()];
    const passed = tests.filter(({ status }) => status === 'passed').length;
    const skipped = tests.filter(({ status }) => status === 'skipped').length;
    const failed = tests.length - passed - skipped;
    const rows = tests.map((test) => [
      test.status.toUpperCase(),
      `${test.file}:${test.line} - ${test.title}`,
      `${test.duration}ms`,
      test.error?.split('\n')[0] ?? '',
    ]);
    const headers = ['STATUS', 'TEST', 'DURATION', 'ERROR'];
    const widths = headers.map((header, index) =>
      Math.max(header.length, ...rows.map((row) => row[index].length)),
    );
    const border = `+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`;
    const formatRow = (row) =>
      `| ${row.map((cell, index) => cell.padEnd(widths[index])).join(' | ')} |`;

    console.log('\nPlaywright test report');
    console.log(border);
    console.log(formatRow(headers));
    console.log(border);
    rows.forEach((row) => console.log(formatRow(row)));
    console.log(border);

    console.log(`Result: ${result.status}`);
    console.log(
      `Summary: ${passed} passed, ${failed} failed, ${skipped} skipped, ${this.total} total`,
    );
  }
}

module.exports = ConsoleReporter;
