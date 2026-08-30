import { registerRootComponent } from "expo";
import App from "./App";

// Explicit registration rather than expo/AppEntry.js: that file resolves the
// app through node_modules, which points into the pnpm store here.
registerRootComponent(App);
