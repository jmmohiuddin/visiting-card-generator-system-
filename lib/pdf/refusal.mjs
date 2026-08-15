/* One refusal type, so every reason the writer will not produce a file
 * reaches the caller in the same shape as a preflight finding.
 *
 * Technical Design §6.3 draws the line: a blocking finding refuses export
 * outright and there is no override. The writer therefore has no partial
 * success — it either hands back a file a press can print or it hands back
 * the reason it would not, named precisely enough that the screen can say
 * what to change. "Something went wrong" is not an acceptable answer to
 * somebody who has already paid.
 */
export class PrintRefusal extends Error {
  constructor(code, message, findings = []) {
    super(message);
    this.name = 'PrintRefusal';
    this.code = code;
    this.findings = findings;
  }
}

export const refuse = (code, message, findings) => { throw new PrintRefusal(code, message, findings); };
