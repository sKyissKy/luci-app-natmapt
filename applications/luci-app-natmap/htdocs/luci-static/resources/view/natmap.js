'use strict';
'require form';
'require fs';
'require uci';
'require rpc';
'require view';
'require network';
'require tools.widgets as widgets';

var conf = 'natmap';
var natmap_instance = 'natmap';
var nattest_fw_rulename = 'natmap-natest';
var nattest_result_path = '/tmp/natmap-natBehavior';

var callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: ['name'],
	expect: { '': {} }
});

var callHostHints = rpc.declare({
	object: 'luci-rpc',
	method: 'getHostHints',
	expect: { '': {} }
});

function getInstances() {
	return L.resolveDefault(callServiceList('natmap'), {}).then(function(res) {
		try {
			return res.natmap.instances || {};
		} catch (e) {}
		return {};
	});
}

function getStatus() {
	return getInstances().then(function(instances) {
		var promises = [];
		var status = {};
		for (var key in instances) {
			var i = instances[key];
			if (i.running && i.pid) {
				var f = '/var/run/natmap/' + i.pid + '.json';
				(function(k) {
					promises.push(fs.read(f).then(function(res) {
						status[k] = JSON.parse(res);
					}).catch(function(e){}));
				})(key);
			}
		}
		return Promise.all(promises).then(function() { return status; });
	});
}

return view.extend({
	load: function() {
	return Promise.all([
		getStatus(),
		network.getWANNetworks(),
		L.resolveDefault(fs.stat('/usr/bin/stunclient'), null),
		L.resolveDefault(fs.read(nattest_result_path), null),
		callHostHints(),
		uci.load('firewall'),
		uci.load('natmap')
	]);
	},

	render: function(res) {
		var status = res[0],
			wans = res[1],
			has_stunclient = res[2].path,
			nattest_result = res[3] ? res[3].trim() : '',
			hosts = res[4];

		var m, s, o;

		m = new form.Map('natmap', _('NATMap'));

		s = m.section(form.TypedSection, 'global');
		s.anonymous = true;

		o = s.option(form.Button, '_reload', _('Reload'));
		o.inputtitle = _('Reload');
		o.inputstyle = 'apply';
		o.onclick = function() {
			window.setTimeout(function() {
				window.location = window.location.href.split('#')[0];
			}, L.env.apply_display * 500);

			return fs.exec('/etc/init.d/natmap', ['reload'])
				.catch(function(e) { ui.addNotification(null, E('p', e.message), 'error') });
		};

		o = s.option(form.Flag, 'enable', _('Enable'));
		o.default = o.disabled;
		o.rmempty = false;

		o = s.option(form.Value, 'def_tcp_stun', _('Default ') + _('TCP STUN ') + _('Server'));
		o.datatype = 'hostname';
		o.rmempty = false;

		o = s.option(form.Value, 'def_udp_stun', _('Default ') + _('UDP STUN ') + _('Server'));
		o.datatype = 'hostname';
		o.rmempty = false;

		o = s.option(form.Value, 'def_http_server', _('Default ') + _('HTTP keep-alive ') + _('Server'));
		o.datatype = 'hostname';
		o.rmempty = false;

		o = s.option(form.Value, 'def_interval', _('Default ') + _('keep-alive interval (seconds)'));
		o.datatype = "and(uinteger, min(1))";
		o.default = 10;
		o.rmempty = false;

		o = s.option(form.Value, 'test_port', _('NATBehavior-Test port open on'), _('Please check <a href="%s"><b>Firewall Rules</b></a> to avoid port conflicts.</br>')
			.format(L.url('admin', 'network', 'firewall'))
			+ _('luci check may not detect all conflicts.'));
		o.datatype = "and(port, min(1))";
		o.placeholder = 3445;
		o.rmempty = false;
		o.validate = function(section_id, value) {
			if (value == null || value == '' || value == 'ignore')
				return _('Expecting: non-empty value');

			let conf = 'firewall';
			let fw_forwards = uci.sections(conf, 'redirect');
			let fw_rules = uci.sections(conf, 'rule');

			for (var i = 0; i < fw_forwards.length; i++) {
				let sid = fw_forwards[i]['.name'];
				if (value == uci.get(conf, sid, 'src_dport'))
					return _('This port is already used');
			};

			for (var i = 0; i < fw_rules.length; i++) {
				let sid = fw_rules[i]['.name'];
				if (uci.get(conf, sid, 'name') == nattest_fw_rulename)
					continue;
				if ( (uci.get(conf, sid, 'dest') || '') == '' ) {
					if (value == uci.get(conf, sid, 'dest_port'))
						return _('This port is already used');
				} else {
					// dest not this device
					continue;
				}
			};

			return true;
		};
		o.write = function(section_id, value) {
			uci.set(conf, section_id, 'test_port', value);

			let found = false;
			let fwcfg = 'firewall';
			let rules = uci.sections(fwcfg, 'rule');
			for (var i = 0; i < rules.length; i++) {
				let sid = rules[i]['.name'];
				if (uci.get(fwcfg, sid, 'name') == nattest_fw_rulename) {
					found = sid;
					break;
				}
			};

			let wan_zone = 'wan';
			if(wans) {
				let def_wan = wans[0].getName();
				let zones = uci.sections(fwcfg, 'zone');
				for (var i = 0; i < zones.length; i++) {
					let sid = zones[i]['.name'];
					if (uci.get(fwcfg, sid, 'masq') == 1) {
						wan_zone = uci.get(fwcfg, sid, 'name');
						break;
					}
				}
			} else {
				for (var i = 0; i < rules.length; i++) {
					let sid = rules[i]['.name'];
					if (uci.get(fwcfg, sid, 'src')) {
						wan_zone = uci.get(fwcfg, sid, 'src');
						break;
					}
				}
			};

			if(found) {
				if (value != uci.get(fwcfg, found, 'dest_port'))
					uci.set(fwcfg, found, 'dest_port', value);
					//fs.exec('/etc/init.d/firewall', ['reload']); // reload on init.d/natmap:service_triggers
			} else {
				let sid = uci.add(fwcfg, 'rule');
				uci.set(fwcfg, sid, 'name', nattest_fw_rulename);
				uci.set(fwcfg, sid, 'src', wan_zone);
				uci.set(fwcfg, sid, 'dest_port', value);
				uci.set(fwcfg, sid, 'target', 'ACCEPT');
				//fs.exec('/etc/init.d/firewall', ['reload']); // reload on init.d/natmap:service_triggers
			}
		};

		o = s.option(form.Button, '_nattest', _('Check NAT Behavior'));
		o.inputtitle = _('Check');
		o.inputstyle = 'apply';
		if (! has_stunclient) {
			o.description = _('To check NAT Behavior you need to install <a href="%s"><b>stuntman-client</b></a> first')
				.format('https://github.com/muink/openwrt-stuntman');
			o.readonly = true;
		}
		o.onclick = function() {
			window.setTimeout(function() {
				window.location = window.location.href.split('#')[0];
			}, 5000);

			let test_port = uci.get_first(conf, 'global', 'test_port');
			let udp_stun_host = uci.get_first(conf, 'global', 'def_udp_stun');
			let tcp_stun_host = uci.get_first(conf, 'global', 'def_tcp_stun');

			return fs.exec('/usr/libexec/natmap/natcheck.sh', [udp_stun_host + ':3478', tcp_stun_host + ':3478', test_port, nattest_result_path])
				.catch(function(e) { ui.addNotification(null, E('p', e.message), 'error') });
		};

		if (nattest_result.length) {
			o = s.option(form.DummyValue, '_nattest_result', '　');
			o.rawhtml = true;
			o.cfgvalue = function(s) {
				return nattest_result;
			}
		};

		s = m.section(form.GridSection, 'natmap');
		s.sortable  = true;
		s.addremove = true;
		s.anonymous = true;

		s.tab('general', _('General Settings'));
		s.tab('forward', _('Forward Settings'));

		o = s.option(form.Flag, 'enable', _('Enable'));
		o.default = o.disabled;
		o.editable = true;
		o.rmempty = true;
		o.modalonly = false;

		o = s.taboption('general', form.Value, 'interval', _('Keep-alive interval'));
		o.datatype = "and(uinteger, min(1))";
		o.rmempty = true;
		o.modalonly = true;

		o = s.taboption('general', form.Value, 'stun_server', _('STUN server'));
		o.datatype = 'hostname';
		o.rmempty = true;
		o.modalonly = true;

		o = s.taboption('general', form.Value, 'http_server', _('HTTP server'), _('For TCP mode'));
		o.datatype = 'hostname';
		o.rmempty = true;
		o.modalonly = true;

		o = s.taboption('general', form.Value, 'comment', _('Comment'));
		o.rmempty = true;

		o = s.taboption('general', form.ListValue, 'udp_mode', _('Protocol'));
		o.default = '0';
		o.value('0', 'TCP');
		o.value('1', 'UDP');
		o.textvalue = function(section_id) {
			var cval = this.cfgvalue(section_id);
			var i = this.keylist.indexOf(cval);
			return this.vallist[i];
		};

		o = s.taboption('general', form.ListValue, 'family', _('Restrict to address family'));
		o.default = 'ipv4';
		o.value('ipv4', _('IPv4'));
		o.value('ipv6', _('IPv6'));
		o.textvalue = function(section_id) {
			var cval = this.cfgvalue(section_id);
			var i = this.keylist.indexOf(cval);
			return this.vallist[i];
		};

		o = s.taboption('general', widgets.DeviceSelect, 'bind_ifname', _('Interface'));
		o.multiple = false;
		o.noaliases = true;
		o.nobridges = true;
		o.nocreate = false;
		o.rmempty = true;

		o = s.taboption('general', form.Value, 'port', _('Bind port'));
		o.datatype = "and(port, min(1))";
		o.rmempty = false;

		o = s.taboption('forward', form.Flag, 'forward_mode', _('Forward mode'));
		o.default = o.disabled;
		o.rmempty = false;

		o = s.taboption('forward', form.ListValue, 'forward_method', _('Forward method'), _('The DNAT method not support under IPv6'));
		o.value('dnat', _('Firewall DNAT'));
		o.value('via', _('Via natmap'));
		o.default = 'via';
		o.rmempty = false;
		o.retain = true;
		o.depends('forward_mode', '1');
		o.modalonly = true;

		o = s.taboption('forward', form.Flag, 'natloopback', _('NAT loopback'));
		o.default = o.enabled;
		o.rmempty = true;
		o.retain = true;
		o.depends('forward_method', 'dnat');
		o.modalonly = true;

		o = s.taboption('forward', form.Value, 'forward_target', _('Forward target'));
		o.datatype = 'ipaddr(1)';
		o.value('127.0.0.1', '127.0.0.1/::1 ' + _('(This device default Lan)'));
		o.value('0.0.0.0', '0.0.0.0/:: ' + _('(This device default Wan)'));
		o.default = '127.0.0.1';
		o.rmempty = false;
		o.retain = true;
		o.depends('forward_mode', '1');

		var ipaddrs = {}, ip6addrs = {};
		Object.keys(hosts).forEach(function(mac) {
			var addrs = L.toArray(hosts[mac].ipaddrs || hosts[mac].ipv4),
				addrs6 = L.toArray(hosts[mac].ip6addrs || hosts[mac].ipv6);

			for (var i = 0; i < addrs.length; i++)
				ipaddrs[addrs[i]] = hosts[mac].name || mac;
			for (var i = 0; i < addrs6.length; i++)
				ip6addrs[addrs6[i]] = hosts[mac].name || mac;
		});
		L.sortedKeys(ipaddrs, null, 'addr').forEach(function(ipv4) {
			o.value(ipv4, ipaddrs[ipv4] ? '%s (%s)'.format(ipv4, ipaddrs[ipv4]) : ipv4);
		});
		L.sortedKeys(ip6addrs, null, 'addr').forEach(function(ipv6) {
			o.value(ipv6, ip6addrs[ipv6] ? '%s (%s)'.format(ipv6, ip6addrs[ipv6]) : ipv6);
		});

		o.textvalue = function(section_id) {
			var cval = this.cfgvalue(section_id);
			var i = this.keylist.indexOf(cval);
			return this.vallist[i];
		};

		o = s.taboption('forward', form.Value, 'forward_port', _('Forward target port'), _('Set 0 will follow Public port'));
		o.datatype = 'port';
		o.rmempty = false;
		o.retain = true;
		o.depends('forward_mode', '1');

		o = s.option(form.Value, 'notify_script', _('Notify script'));
		o.datatype = 'file';
		o.modalonly = true;

		o = s.option(form.DummyValue, '_external_ip', _('External IP'));
		o.modalonly = false;
		o.textvalue = function(section_id) {
			var s = status[section_id];
			if (s) return s.ip;
		};

		o = s.option(form.DummyValue, '_external_port', _('External Port'));
		o.modalonly = false;
		o.textvalue = function(section_id) {
			var s = status[section_id];
			if (s) return s.port;
		};

		return m.render();
	}
});
