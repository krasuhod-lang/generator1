import ast

with open('relevance/app/parser.py', 'r') as f:
    tree = ast.parse(f.read())

for node in tree.body:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        print(f"{type(node).__name__}: {node.name}")
        if ast.get_docstring(node):
            print(f"  Docstring: {ast.get_docstring(node).splitlines()[0]}")
