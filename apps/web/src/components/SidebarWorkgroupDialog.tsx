import { type ReactNode, useId, useState } from "react";

import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { randomUUID } from "~/lib/utils";
import { type SidebarWorkgroup, useUiStateStore } from "../uiStateStore";
import { ProjectFavicon } from "./ProjectFavicon";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

/**
 * Creates (`workgroup` null) or edits a sidebar workgroup. Member keys for
 * projects not in `projects` (for example on a disconnected environment) are
 * kept as-is, so editing never drops them.
 */
export function SidebarWorkgroupDialog(props: {
  workgroup: SidebarWorkgroup | null;
  projects: readonly SidebarProjectSnapshot[];
  projectBadge?: ((project: SidebarProjectSnapshot) => ReactNode) | undefined;
  onSaved: (workgroupId: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const saveWorkgroup = useUiStateStore((store) => store.saveSidebarWorkgroup);
  const deleteWorkgroup = useUiStateStore((store) => store.deleteSidebarWorkgroup);
  const [name, setName] = useState(props.workgroup?.name ?? "");
  const [projectKeys, setProjectKeys] = useState<ReadonlySet<string>>(
    () => new Set(props.workgroup?.projectKeys ?? []),
  );
  const canSave = name.trim().length > 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSave) return;
            const workgroupId = props.workgroup?.id ?? randomUUID();
            saveWorkgroup({ id: workgroupId, name, projectKeys: [...projectKeys] });
            props.onSaved(workgroupId);
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.workgroup ? "Edit workgroup" : "New workgroup"}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <Label className="flex flex-col items-stretch" htmlFor={`${id}-name`}>
                Name
                <Input
                  nativeInput
                  id={`${id}-name`}
                  autoFocus
                  required
                  placeholder="Client work"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Label>
              <div className="flex min-h-0 flex-col gap-1.5">
                <span className="text-sm font-medium">Projects</span>
                <div className="-mx-1 flex max-h-72 flex-col overflow-y-auto">
                  {props.projects.map((project) => (
                    <label
                      key={project.projectKey}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 hover:bg-accent"
                    >
                      <Checkbox
                        checked={projectKeys.has(project.projectKey)}
                        onCheckedChange={(checked) => {
                          setProjectKeys((current) => {
                            const next = new Set(current);
                            if (checked) next.add(project.projectKey);
                            else next.delete(project.projectKey);
                            return next;
                          });
                        }}
                      />
                      <ProjectFavicon project={project} className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-sm">{project.displayName}</span>
                      {props.projectBadge?.(project)}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </DialogPanel>
          <DialogFooter>
            {props.workgroup ? (
              <Button
                type="button"
                variant="destructive-outline"
                className="sm:mr-auto"
                onClick={() => {
                  deleteWorkgroup(props.workgroup!.id);
                  props.onClose();
                }}
              >
                Delete
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
