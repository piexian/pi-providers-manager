import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync, symlinkSync, lstatSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { editAgentField, parseAgentFields, setAgentField } from "../src/agent-frontmatter.ts";

const yaml = (text: string) => text.replace(/^\uFEFF/, "").split(/---\r?\n/)[1];
for (const style of ["|", ">", "|-", ">+", "|2-"]) {
	test(`editing/removing ${style} replaces the entire managed scalar, not just its header`, () => {
		const source = `---\nname: demo\ndescription: ${style} # note\n  old first line\n  old second line\ntools: read,bash\nextra: { exact: 'keep' }\n---\nPrompt\n`;
		const next = editAgentField(source, "description", "new description");
		assert.equal(parse(yaml(next)).description, "new description");
		assert.doesNotMatch(next, /old first|old second/);
		assert.ok(next.includes("# note\n"));
		assert.ok(next.endsWith("tools: read,bash\nextra: { exact: 'keep' }\n---\nPrompt\n"));
		const cleared = editAgentField(source, "description", undefined);
		assert.equal(parse(yaml(cleared)).description, undefined);
		assert.equal(parse(yaml(cleared)).tools, "read,bash");
		assert.doesNotMatch(cleared, /old first|old second/);
	});
}

test("BOM, CRLF, unrelated comments/fields and prompt bytes survive", () => {
	const source = "\uFEFF---\r\n# keep\r\nname: demo\r\ndescription: |\r\n  old\r\ntools: read\r\n---\r\nPrompt\r\n  preserve\r\n";
	const next = editAgentField(source, "description", "new\nmultiline");
	assert.ok(next.startsWith("\uFEFF---\r\n# keep\r\nname: demo\r\n"));
	assert.ok(next.endsWith("tools: read\r\n---\r\nPrompt\r\n  preserve\r\n"));
	assert.doesNotMatch(next, /(?<!\r)\n/);
	assert.equal(parse(yaml(next)).description, "new\nmultiline");
});

test("quoted, blank, missing and final multiline values remain valid YAML", () => {
	for (const fields of ["description: 'old' # note", "description:", "description: |\n  final line", "name: demo", ""]) {
		const next = editAgentField(`---\n${fields}\n---\nPrompt`, "description", "a: value # literal");
		assert.equal(parse(yaml(next)).description, "a: value # literal");
		assert.ok(next.endsWith("\n---\nPrompt"));
	}
	assert.deepEqual(parseAgentFields("description: >\n  one\n  two\ntools: [read, bash]"), { description: "one two\n", tools: "read,bash" });
});

test("malformed, duplicate-key, flow and dangling-alias edits fail without writing", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-agent-yaml-test-"));
	t.after(() => { for (const file of readdirSync(dir)) unlinkSync(join(dir, file)); rmdirSync(dir); });
	const path = join(dir, "demo.md");
	for (const fields of ['description: "new"\n  old body', "description: a\ndescription: b", "{name: demo, description: old}", "description: &label old\nextra: *label"]) {
		const source = `---\n${fields}\n---\nPrompt`;
		writeFileSync(path, source);
		assert.throws(() => setAgentField(path, "description", undefined), /未修改文件/);
		assert.equal(readFileSync(path, "utf8"), source);
		assert.deepEqual(readdirSync(dir), ["demo.md"]);
	}
});

test("atomic replacement preserves symlink and file mode", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-agent-yaml-symlink-"));
	t.after(() => { for (const file of readdirSync(dir)) unlinkSync(join(dir, file)); rmdirSync(dir); });
	const target = join(dir, "target.md"), link = join(dir, "agent.md");
	writeFileSync(target, "---\nname: demo\ndescription: |\n  old\n---\nPrompt", { mode: 0o640 });
	symlinkSync(target, link);
	setAgentField(link, "description", "updated");
	assert.equal(lstatSync(link).isSymbolicLink(), true);
	assert.equal(statSync(target).mode & 0o777, 0o640);
	assert.equal(parse(yaml(readFileSync(target, "utf8"))).description, "updated");
	assert.deepEqual(readdirSync(dir).sort(), ["agent.md", "target.md"]);
});
