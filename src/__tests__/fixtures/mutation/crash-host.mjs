// A Stryker host that cannot start, as when @stryker-mutator/core is not
// installed: it writes why and exits before saying anything over IPC.
process.stderr.write("Cannot find package '@stryker-mutator/core'\n");
process.exit(1);
