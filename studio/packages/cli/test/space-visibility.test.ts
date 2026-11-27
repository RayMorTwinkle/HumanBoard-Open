import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAppService } from "../src/local-app-service";
import { parseCliArgs } from "../src/parser";

test("space trash survives reopening; restore retains history and deleted spaces reject edits", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hb-trash-"));
  const options = {
    cwd,
    env: { HUMANBOARD_HOME: join(cwd, "data"), HUMAN_AUTO_TITLE: "off" },
  };
  let app = await LocalAppService.create(options);
  const command = async (args: string[]) => {
    const p = parseCliArgs(args);
    return (await app.execute(p.command, p.global)).data as any;
  };
  try {
    await command(["init"]);
    const original = await command(["status"]);
    const other = await command(["space", "create", "Second"]);
    await command(["space", "delete", other.space_id]);
    expect((await command(["space", "ls"])).spaces).toHaveLength(1);
    expect((await command(["space", "trash"])).spaces[0].id).toBe(
      other.space_id,
    );
    await expect(
      command(["space", "switch", other.space_id]),
    ).rejects.toMatchObject({ code: "E_SPACE_DELETED" });
    await expect(
      command(["space", "delete", original.space.id]),
    ).rejects.toMatchObject({ code: "E_USAGE" });
    app.close();
    app = await LocalAppService.create(options);
    expect((await command(["status"])).deleted_spaces[0].id).toBe(
      other.space_id,
    );
    await command(["space", "restore", other.space_id]);
    expect((await command(["space", "ls"])).spaces).toHaveLength(2);
    await command(["space", "switch", original.space.id]);
    await command(["space", "delete", original.space.id]);
    expect((await command(["status"])).space.deleted).toBe(true);
    await expect(command(["layers"])).rejects.toMatchObject({
      code: "E_SPACE_DELETED",
    });
    await command(["space", "restore", original.space.id]);
    expect((await command(["status"])).layers).toEqual(original.layers);
  } finally {
    app.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
