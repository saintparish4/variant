import type { ResolvedVariantConfig } from "../../types/index.js";
import { TaskGraph } from "./dag.js";

export function buildGraph(config: ResolvedVariantConfig): TaskGraph {
	const graph = new TaskGraph();
	for (const [name, task] of Object.entries(config.tasks)) {
		graph.addTask(name);
		task.dependsOn?.forEach((dep) => {
			graph.addDependency(name, dep);
		});
	}
	return graph;
}
