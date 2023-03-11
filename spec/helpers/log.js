const { SpecReporter } = require('jasmine-spec-reporter');


jasmine.getEnv().clearReporters(); // Clear default console reporter
jasmine.getEnv().addReporter(new SpecReporter());
