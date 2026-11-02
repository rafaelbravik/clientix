const SOURCE_HEAD_LABEL = "com.clientix.source-head";
const SOURCE_DIRTY_LABEL = "com.clientix.source-dirty";
const RELEASE_ELIGIBLE_LABEL = "com.clientix.release-eligible";
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * Checks the provenance contract shared by all required release images.
 * The caller supplies the commit from the build job, never a value from image metadata.
 * Only mismatched label names are returned so diagnostics cannot expose label values.
 *
 * @param {Record<string, unknown>} labels
 * @param {string} expectedHead
 * @returns {string[]}
 */
export function releaseImageMetadataMismatches(labels, expectedHead) {
  if (!COMMIT_SHA_RE.test(expectedHead)) return ["expected-source-head"];

  const sourceHead = labels[SOURCE_HEAD_LABEL];
  const sourceHeadValid = typeof sourceHead === "string" && COMMIT_SHA_RE.test(sourceHead);
  const expected = [
    [SOURCE_HEAD_LABEL, sourceHeadValid && sourceHead === expectedHead],
    [SOURCE_DIRTY_LABEL, labels[SOURCE_DIRTY_LABEL] === "false"],
    [RELEASE_ELIGIBLE_LABEL, labels[RELEASE_ELIGIBLE_LABEL] === "true"],
  ];

  return expected.filter(([, valid]) => !valid).map(([label]) => label);
}
