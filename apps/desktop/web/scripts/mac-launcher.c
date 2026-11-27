/*
 * actor0.app's CFBundleExecutable.
 *
 * Why this exists: the launcher that starts the agent is a shell script, and
 * Apple's guidance is that scripts belong in Contents/Resources, not
 * Contents/MacOS. A script named as CFBundleExecutable can be signed, but its
 * signature lives in extended attributes, which zip/ditto round-trips only
 * sometimes and a browser download does not guarantee. A Mach-O executable is
 * signed in the file itself, so the bundle verifies after any transfer.
 *
 * All this does is exec /bin/sh on Contents/Resources/run.sh, telling it where
 * the executable directory is (the script cannot derive it from its own path
 * once it lives one directory over).
 */
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
  uint32_t size = 0;
  if (_NSGetExecutablePath(NULL, &size) != -1) return 127;
  char *exe = malloc(size);
  if (exe == NULL) return 127;
  if (_NSGetExecutablePath(exe, &size) != 0) return 127;

  char *dir = dirname(exe);
  char script[PATH_MAX];
  int written = snprintf(script, sizeof script, "%s/../Resources/run.sh", dir);
  if (written < 0 || written >= (int)sizeof script) return 127;

  /* The script's resources live beside this executable, not beside run.sh. */
  if (setenv("ACTOR0_APP_DIR", dir, 1) != 0) return 127;

  char **args = calloc((size_t)argc + 2, sizeof(char *));
  if (args == NULL) return 127;
  args[0] = "/bin/sh";
  args[1] = script;
  for (int i = 1; i < argc; i++) args[i + 1] = argv[i];

  execv("/bin/sh", args);
  perror("actor0");
  return 127;
}
