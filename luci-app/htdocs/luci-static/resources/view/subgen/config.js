'require view';
'require subgen.ui as App';

/*
 * LuCI 会把每个模块 factory 的返回值 `new` 一次再挂到命名空间（luci.js 的
 * compileClass：`const instance = new _class(); ptr[parts[idx]] = instance;`），
 * 所以这里的 App 是 subgen.ui 那个 class 的**实例**，不是 class。
 *
 * 而 view 模块的 factory 必须返回 class（否则 Class.isSubclass() 为假，
 * 报 `factory yields invalid constructor`）。因此不能再 `return App`，
 * 要用 view.extend 包一层 —— 渲染仍然走同一份 UI 实现，真源只有一份。
 */
return view.extend({
	render: function () {
		return App.render();
	},

	/* 这页没有 UCI 表单：保存由页面自己的按钮走 subgen 的 HTTP 接口，
	 * null 掉这三个方法，LuCI 就不会再叠一排默认的保存/应用/重置。 */
	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
